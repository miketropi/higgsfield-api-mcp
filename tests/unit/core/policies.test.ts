import { describe, expect, it } from 'vitest';
import { createMemoryRateLimiter, GatewayError, REDACTION_CENSOR, sanitizeDetails, redactUrlQuery, safeUrlForLogging, toStructuredError } from '@higgsfield-mcp/core';

describe('memory rate limiter', () => {
  it('checks every dimension before consuming any counter and reports retry timing', async () => {
    let now = new Date('2026-10-01T00:00:00.000Z');
    const limiter = createMemoryRateLimiter({ clock: { now: () => now } });
    const tenant = { dimension: 'tenant' as const, key: 'tenant-a', rule: { limit: 5, windowMs: 60_000 } };
    const tool = { dimension: 'tool' as const, key: 'generate_image', rule: { limit: 1, windowMs: 60_000 } };

    expect(await limiter.check([tenant])).toEqual({ allowed: true });
    expect(await limiter.check([tenant, tool])).toEqual({ allowed: true });
    const denied = await limiter.check([tenant, tool]);
    expect(denied.allowed).toBe(false);
    expect(denied.limitedBy).toBe('tool');
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);

    // The tenant dimension still has room because the denied request was not consumed.
    expect((await limiter.check([tenant])).allowed).toBe(true);

    now = new Date('2026-10-01T00:01:01.000Z');
    expect((await limiter.check([tenant, tool])).allowed).toBe(true);
  });

  it('does not burn quota on other dimensions when one dimension is exhausted', async () => {
    const limiter = createMemoryRateLimiter();
    const exhausted = { dimension: 'provider' as const, key: 'higgsfield', rule: { limit: 1, windowMs: 60_000 } };
    const roomy = { dimension: 'token' as const, key: 'token-1', rule: { limit: 2, windowMs: 60_000 } };
    expect((await limiter.check([exhausted, roomy])).allowed).toBe(true);
    expect((await limiter.check([exhausted, roomy])).allowed).toBe(false);
    // The denied request must not have consumed the token dimension (1 of 2 used).
    expect((await limiter.check([roomy])).allowed).toBe(true);
  });
});

describe('error envelope and redaction', () => {
  it('serializes only the allowlisted fields and sanitizes details', () => {
    const error = new GatewayError('RATE_LIMITED', 'Too many requests.', {
      retryAfterMs: 1_500,
      details: {
        authorization: 'Bearer sk-sentinel-credential',
        upload_headers: { 'x-amz-tagging': 'secret' },
        url: 'https://cdn.example.com/a.png?X-Amz-Signature=abc',
        keep: 'value',
        nested: { access_token: 'nope', ok: 1 },
        fn: () => undefined
      },
      cause: new Error('provider internals')
    });
    const structured = toStructuredError(error);
    expect(structured).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 1_500 });
    const serialized = JSON.stringify(structured);
    expect(serialized).not.toContain('sk-sentinel-credential');
    expect(serialized).not.toContain('X-Amz-Signature');
    expect(serialized).not.toContain('provider internals');
    expect(structured.details?.['keep']).toBe('value');
    expect(structured.details?.['authorization']).toBe(REDACTION_CENSOR);
  });

  it('never leaks unknown errors verbatim', () => {
    const structured = toStructuredError(new Error('axios request config with auth header'));
    expect(structured.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(structured)).not.toContain('axios');
  });

  it('strips signed query strings from URLs used in logs', () => {
    expect(redactUrlQuery('https://cdn.example.com/a.png?X-Amz-Signature=abc')).toBe(
      `https://cdn.example.com/a.png?${REDACTION_CENSOR}`
    );
    expect(safeUrlForLogging('https://user:pass@cdn.example.com/a.png?token=1')).not.toContain('pass');
    expect(safeUrlForLogging('https://user:pass@cdn.example.com/a.png?token=1')).not.toContain('token=1');
  });

  it('drops cyclic and oversized detail structures', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    const sanitized = sanitizeDetails(cyclic);
    expect(sanitized?.['name']).toBe('root');
    expect(sanitized?.['self']).toBeUndefined();
  });
});
