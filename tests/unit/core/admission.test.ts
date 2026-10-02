import { describe, expect, it } from 'vitest';
import { createAdmission, createMemoryRateLimiter, GatewayError } from '@higgsfield-mcp/core';
import type { AdmissionRules, RateLimiter, RequestContext } from '@higgsfield-mcp/core';
import { createSilentLogger } from '../../fixtures/fakes.js';

const rules = (overrides: Partial<AdmissionRules> = {}): AdmissionRules => ({
  global: { limit: 100, windowMs: 60_000 },
  perClass: {
    image: { limit: 100, windowMs: 60_000 },
    video: { limit: 100, windowMs: 60_000 },
    other: { limit: 100, windowMs: 60_000 },
    upload: { limit: 100, windowMs: 60_000 },
    read: { limit: 100, windowMs: 60_000 }
  },
  ...overrides
});

const context = (tenantId = 'tenant-a'): RequestContext => ({
  requestId: 'req',
  tenantId,
  transport: 'http',
  auth: { tenantId, mode: 'static_token', scopes: ['higgsfield:generate'], tokenId: 'token-1' }
});

describe('admission', () => {
  it('refuses with RATE_LIMITED and a retry hint once a ceiling is reached', async () => {
    const admission = createAdmission({
      limiter: createMemoryRateLimiter(),
      rules: rules({ perClass: { image: { limit: 2, windowMs: 60_000 }, video: { limit: 5, windowMs: 60_000 }, other: { limit: 5, windowMs: 60_000 }, upload: { limit: 5, windowMs: 60_000 }, read: { limit: 5, windowMs: 60_000 } } }),
      logger: createSilentLogger(),
      failClosed: false
    });
    await admission.admit({ tool: 'higgsfield.generate_image', class: 'image', context: context() });
    await admission.admit({ tool: 'higgsfield.generate_image', class: 'image', context: context() });
    await expect(
      admission.admit({ tool: 'higgsfield.generate_image', class: 'image', context: context() })
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    try {
      await admission.admit({ tool: 'higgsfield.generate_image', class: 'image', context: context() });
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('scopes the tenant ceiling to the tenant, not the process', async () => {
    const admission = createAdmission({
      limiter: createMemoryRateLimiter(),
      rules: rules({ perClass: { image: { limit: 1, windowMs: 60_000 }, video: { limit: 1, windowMs: 60_000 }, other: { limit: 1, windowMs: 60_000 }, upload: { limit: 1, windowMs: 60_000 }, read: { limit: 1, windowMs: 60_000 } } }),
      logger: createSilentLogger(),
      failClosed: false
    });
    await admission.admit({ tool: 't', class: 'image', context: context('tenant-a') });
    await expect(admission.admit({ tool: 't', class: 'image', context: context('tenant-a') })).rejects.toMatchObject({
      code: 'RATE_LIMITED'
    });
    await expect(admission.admit({ tool: 't', class: 'image', context: context('tenant-b') })).resolves.toMatchObject({
      allowed: true
    });
  });

  it('fails closed when the limiter is unavailable and remote, and admits locally', async () => {
    const broken: RateLimiter = {
      async check() {
        throw new Error('redis down');
      },
      async health() {},
      async close() {}
    };
    const remote = createAdmission({ limiter: broken, rules: rules(), logger: createSilentLogger(), failClosed: true });
    await expect(remote.admit({ tool: 't', class: 'read', context: context() })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { component: 'rate_limiter' }
    });
    const local = createAdmission({ limiter: broken, rules: rules(), logger: createSilentLogger(), failClosed: false });
    await expect(local.admit({ tool: 't', class: 'read', context: context() })).resolves.toMatchObject({ allowed: true });
  });
});
