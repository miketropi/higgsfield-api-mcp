/**
 * Redis-backed `RateLimiter` (SPEC §38, §66).
 *
 * One Lua script evaluates *every* dimension of a request and only then consumes
 * quota, so a request rejected on one dimension never burns another. The window is
 * a sliding window over a sorted set of millisecond timestamps, pruned and expired
 * server-side.
 *
 * Failure policy: a limiter outage must not silently open admission. `check()`
 * fails closed by raising `INTERNAL_ERROR` with `retryable: true` and
 * `details.component = 'rate_limiter'`, which the HTTP layer maps to a closed
 * admission decision.
 *
 * Keys are `${keyPrefix}:{<dimension>:<key>}`; the shared `{}` hash tag keeps every
 * dimension of one logical check in the same Redis Cluster slot, which a
 * multi-key script requires.
 */
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { GatewayError } from '../errors.js';
import type { Clock, LoggerPort, RateLimitDecision, RateLimitDimension, RateLimiter } from '../contracts.js';

export interface RedisRateLimiterOptions {
  url: string;
  logger: LoggerPort;
  /** Key namespace; also the Redis Cluster hash tag. */
  keyPrefix?: string;
  clock?: Clock;
  /**
   * Bounded reconnect attempts before the client stays down and `check()` fails
   * closed. Defaults to 20 (~10s of retries).
   */
  reconnectAttempts?: number;
}

const DEFAULT_KEY_PREFIX = 'hf:mcp:rl';
const CONNECT_TIMEOUT_MS = 5_000;
const MAX_RECONNECT_ATTEMPTS = 20;
const MAX_RECONNECT_DELAY_MS = 2_000;

/**
 * Sliding-window check in one round trip.
 *
 * ARGV: [1] now (ms), [2] dimension count, then per dimension `limit`, `windowMs`,
 * then the unique member names. Returns `{allowed, retryAfterMs, limitedIndex}`
 * where `limitedIndex` is 1-based (0 when allowed).
 */
const SLIDING_WINDOW_SCRIPT = `
local now = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
local retry = 0
local limited = 0
for i = 1, count do
  local limit = tonumber(ARGV[2 + (i - 1) * 2 + 1])
  local window = tonumber(ARGV[2 + (i - 1) * 2 + 2])
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - window)
  local size = redis.call('ZCARD', KEYS[i])
  if size >= limit then
    local oldest = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    local wait = window
    if oldest[2] ~= nil then
      wait = window - (now - tonumber(oldest[2]))
      if wait < 1 then wait = 1 end
    end
    if wait > retry then
      retry = wait
      limited = i
    end
  end
end
if limited > 0 then
  return {0, retry, limited}
end
for i = 1, count do
  local window = tonumber(ARGV[2 + (i - 1) * 2 + 2])
  redis.call('ZADD', KEYS[i], now, ARGV[2 + count * 2 + i])
  redis.call('PEXPIRE', KEYS[i], window)
end
return {1, 0, 0}
`;

function unavailable(): GatewayError {
  return new GatewayError('INTERNAL_ERROR', 'Rate limiter unavailable', {
    retryable: true,
    details: { component: 'rate_limiter' }
  });
}

/** Parses the Lua reply, failing closed on anything unexpected. */
function parseDecision(raw: unknown, dimensions: RateLimitDimension[]): RateLimitDecision {
  if (!Array.isArray(raw) || raw.length < 3) throw unavailable();
  const allowed = Number(raw[0]);
  const retryAfterMs = Number(raw[1]);
  const limitedIndex = Number(raw[2]);
  if (allowed === 1) return { allowed: true };
  const wait = Number.isFinite(retryAfterMs) ? Math.max(1, Math.ceil(retryAfterMs)) : 1;
  const limited = dimensions[limitedIndex - 1];
  return limited === undefined
    ? { allowed: false, retryAfterMs: wait }
    : { allowed: false, retryAfterMs: wait, limitedBy: limited.dimension };
}

export function createRedisRateLimiter(options: RedisRateLimiterOptions): RateLimiter {
  const logger = options.logger;
  const clock = options.clock ?? { now: () => new Date() };
  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const maxReconnectAttempts = options.reconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;
  /** Distinguishes members from different limiter instances (process, pod, container). */
  const instanceId = randomUUID().slice(0, 8);
  let sequence = 0;

  const client = createClient({
    url: options.url,
    // Commands must fail fast while disconnected: a queued check would hang
    // admission instead of failing closed.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries: number) =>
        retries > maxReconnectAttempts
          ? new Error('Rate limiter reconnect limit reached')
          : Math.min(retries * 50, MAX_RECONNECT_DELAY_MS)
    }
  });
  client.on('error', (error: Error) => {
    // Never log the connection URL: it may carry credentials.
    logger.warn({ component: 'rate_limiter', event: 'client_error', error: error.name }, 'redis client error');
  });

  let connecting: Promise<void> | undefined;
  const ensureConnected = async (): Promise<void> => {
    if (client.isReady) return;
    connecting ??= client.connect().then(
      () => undefined,
      (error: unknown) => {
        // Allow a later call to retry instead of caching a permanent rejection.
        connecting = undefined;
        throw error;
      }
    );
    await connecting;
  };

  return {
    async check(dimensions: RateLimitDimension[]): Promise<RateLimitDecision> {
      if (dimensions.length === 0) return { allowed: true };
      const now = clock.now().getTime();
      const keys = dimensions.map((dimension) => `${keyPrefix}:{${dimension.dimension}:${dimension.key}}`);
      const args = [String(now), String(dimensions.length)];
      for (const dimension of dimensions) {
        args.push(String(dimension.rule.limit), String(dimension.rule.windowMs));
      }
      for (let index = 0; index < dimensions.length; index += 1) {
        sequence += 1;
        args.push(`${now}-${instanceId}-${sequence}`);
      }
      try {
        await ensureConnected();
        const raw: unknown = await client.eval(SLIDING_WINDOW_SCRIPT, { keys, arguments: args });
        return parseDecision(raw, dimensions);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        const name = error instanceof Error ? error.name : 'UnknownError';
        logger.warn({ component: 'rate_limiter', event: 'check_failed', error: name }, 'rate limiter check failed');
        throw unavailable();
      }
    },

    async health(): Promise<void> {
      try {
        await ensureConnected();
        await client.ping();
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError('INTERNAL_ERROR', 'Rate limiter health check failed', {
          retryable: true,
          details: { component: 'rate_limiter' }
        });
      }
    },

    async close(): Promise<void> {
      if (!client.isOpen) return;
      try {
        await client.quit();
      } catch (error) {
        logger.warn(
          { component: 'rate_limiter', event: 'close_failed', error: error instanceof Error ? error.name : 'UnknownError' },
          'redis client close failed'
        );
        // Drop the socket so a failed QUIT cannot keep the process alive.
        client.destroy();
      }
    }
  };
}
