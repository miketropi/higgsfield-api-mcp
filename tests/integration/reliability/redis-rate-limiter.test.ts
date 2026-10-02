/**
 * Redis rate limiter contract, against a disposable Redis
 * (`HF_MCP_TEST_REDIS_URL`).
 *
 * A controllable clock keeps the sliding-window arithmetic exact: the script uses
 * the caller-supplied timestamp, not the server clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisRateLimiter } from '@higgsfield-mcp/core';
import type { Clock, RateLimitDimension, RateLimiter } from '@higgsfield-mcp/core';
import { TEST_REDIS_URL, announceSkip, silentLogger, uniqueSuffix } from './support/services.js';

const SUITE = 'Redis rate limiter';
if (TEST_REDIS_URL === undefined) announceSkip(SUITE, 'HF_MCP_TEST_REDIS_URL');

const KEY_PREFIX = `hf:test:rl:${uniqueSuffix()}`;
const WINDOW_MS = 5_000;

function dimension(
  name: 'tenant' | 'token' | 'tool' | 'provider' | 'global',
  key: string,
  limit: number,
  windowMs = WINDOW_MS
): RateLimitDimension {
  return { dimension: name, key: `${key}_${uniqueSuffix()}`, rule: { limit, windowMs } };
}

describe.skipIf(TEST_REDIS_URL === undefined)(SUITE, () => {
  let nowMs = Date.parse('2026-10-02T10:00:00.000Z');
  const clock: Clock = { now: () => new Date(nowMs) };
  let limiter: RateLimiter;

  beforeAll(async () => {
    if (TEST_REDIS_URL === undefined) throw new Error('HF_MCP_TEST_REDIS_URL is required');
    limiter = createRedisRateLimiter({ url: TEST_REDIS_URL, logger: silentLogger(), keyPrefix: KEY_PREFIX, clock });
    await limiter.health();
  });

  afterAll(async () => {
    await limiter?.close();
  });

  it('allows up to the limit, then reports retryAfterMs for the exhausted dimension', async () => {
    const tenantDimension = dimension('tenant', 'limit', 2);

    expect(await limiter.check([tenantDimension])).toEqual({ allowed: true });
    expect(await limiter.check([tenantDimension])).toEqual({ allowed: true });

    nowMs += 40;
    const denied = await limiter.check([tenantDimension]);
    expect(denied.allowed).toBe(false);
    expect(denied.limitedBy).toBe('tenant');
    // The oldest admitted request leaves the window after `windowMs`.
    expect(denied.retryAfterMs).toBe(WINDOW_MS - 40);

    // ...and the window slides: once the first entry ages out, one slot returns.
    nowMs += WINDOW_MS;
    expect(await limiter.check([tenantDimension])).toEqual({ allowed: true });
  });

  it('never exceeds the limit when checks arrive concurrently', async () => {
    const providerDimension = dimension('provider', 'concurrent', 5);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.check([providerDimension]))
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(15);
  });

  it('is all-or-nothing: a rejected check consumes no quota on any dimension', async () => {
    const tenantDimension = dimension('tenant', 'isolation', 2);
    const toolDimension = dimension('tool', 'isolation', 1);

    expect(await limiter.check([tenantDimension, toolDimension])).toEqual({ allowed: true });

    nowMs += 10;
    const denied = await limiter.check([tenantDimension, toolDimension]);
    expect(denied.allowed).toBe(false);
    expect(denied.limitedBy).toBe('tool');

    // The rejected check must not have consumed the tenant dimension: it still has
    // exactly one slot left from the single admitted request.
    expect(await limiter.check([tenantDimension])).toEqual({ allowed: true });
    const exhausted = await limiter.check([tenantDimension]);
    expect(exhausted.allowed).toBe(false);
  });

  it('separates dimensions of the same name by key', async () => {
    const first = dimension('tenant', 'separate_a', 1);
    const second = dimension('tenant', 'separate_b', 1);

    expect(await limiter.check([first])).toEqual({ allowed: true });
    expect(await limiter.check([second])).toEqual({ allowed: true });
    expect((await limiter.check([first])).allowed).toBe(false);
  });

  it('treats an empty dimension list as allowed without touching Redis', async () => {
    expect(await limiter.check([])).toEqual({ allowed: true });
  });

  it('fails closed when Redis is not reachable', async () => {
    const unreachable = createRedisRateLimiter({
      // Reserved port that nothing listens on: a limiter outage must not open admission.
      url: 'redis://127.0.0.1:1',
      logger: silentLogger(),
      keyPrefix: KEY_PREFIX,
      clock,
      reconnectAttempts: 1
    });
    try {
      await expect(unreachable.check([dimension('tenant', 'unreachable', 1)])).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        retryable: true,
        details: { component: 'rate_limiter' }
      });
    } finally {
      await unreachable.close();
    }
  }, 30_000);

  it('answers health checks against a live server', async () => {
    await expect(limiter.health()).resolves.toBeUndefined();
  });
});
