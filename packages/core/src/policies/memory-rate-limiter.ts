import type { Clock, RateLimitDecision, RateLimitDimension, RateLimiter } from '../contracts.js';

interface WindowState {
  timestamps: number[];
}

/**
 * In-process sliding-window limiter used for stdio/local mode. All dimensions are
 * evaluated before any of them is consumed, so a rejected request never burns
 * quota on another dimension.
 */
export function createMemoryRateLimiter(options: { clock?: Clock | undefined } = {}): RateLimiter {
  const clock = options.clock ?? { now: () => new Date() };
  const windows = new Map<string, WindowState>();

  const dimensionKey = (dimension: RateLimitDimension): string => `${dimension.dimension}\u0000${dimension.key}`;

  const prune = (key: string, now: number, windowMs: number): number[] => {
    const state = windows.get(key) ?? { timestamps: [] };
    const kept = state.timestamps.filter((timestamp) => now - timestamp < windowMs);
    state.timestamps = kept;
    windows.set(key, state);
    return kept;
  };

  return {
    async check(dimensions: RateLimitDimension[]): Promise<RateLimitDecision> {
      if (dimensions.length === 0) return { allowed: true };
      const now = clock.now().getTime();
      let retryAfterMs = 0;
      let limitedBy: RateLimitDimension['dimension'] | undefined;

      for (const dimension of dimensions) {
        const key = dimensionKey(dimension);
        const kept = prune(key, now, dimension.rule.windowMs);
        if (kept.length >= dimension.rule.limit) {
          const oldest = kept[0] ?? now;
          const wait = dimension.rule.windowMs - (now - oldest);
          if (wait > retryAfterMs) {
            retryAfterMs = wait;
            limitedBy = dimension.dimension;
          }
        }
      }

      if (limitedBy !== undefined) {
        return { allowed: false, retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)), limitedBy };
      }
      for (const dimension of dimensions) {
        const key = dimensionKey(dimension);
        const state = windows.get(key) ?? { timestamps: [] };
        state.timestamps.push(now);
        windows.set(key, state);
      }
      return { allowed: true };
    },

    async health() {
      await Promise.resolve();
    },

    async close() {
      windows.clear();
      await Promise.resolve();
    }
  };
}
