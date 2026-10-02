import { describe, expect, it } from 'vitest';
import { createMemoryJobRepository, newOpaqueToken, sha256Hex } from '@higgsfield-mcp/core';
import type { SubmissionEnvelope } from '@higgsfield-mcp/core';
import { createWebhookHandler } from '@higgsfield-mcp/server/webhooks/higgsfield.js';
import { createSilentLogger, createNullMetrics } from '../../fixtures/fakes.js';

const token = newOpaqueToken(32);

async function seededRepository(): Promise<ReturnType<typeof createMemoryJobRepository>> {
  const repository = createMemoryJobRepository();
  const envelope: SubmissionEnvelope = {
    jobId: 'job_bound',
    tenantId: 'tenant-a',
    provider: 'higgsfield',
    providerAccountId: 'acct',
    jobKind: 'generation',
    concurrencyClass: 'image',
    endpoint: 'xai/grok-imagine-image-2.0',
    upstreamIdempotencyKey: '11111111-1111-1111-1111-111111111111',
    body: { prompt: 'x' },
    bodyHash: 'a'.repeat(64),
    state: 'acknowledged',
    attempts: 1,
    providerJobId: 'generation:abc',
    callbackToken: token,
    callbackTokenHash: sha256Hex(token),
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z'
  };
  await repository.transaction((tx) => tx.putSubmission(envelope));
  return repository;
}

function handlerFor(repository: ReturnType<typeof createMemoryJobRepository>): {
  handle: ReturnType<typeof createWebhookHandler>;
  nudged: string[];
} {
  const nudged: string[] = [];
  const handle = createWebhookHandler({
    repository,
    logger: createSilentLogger(),
    metrics: createNullMetrics(),
    nudge: (jobId) => nudged.push(jobId)
  });
  return { handle, nudged };
}

describe('higgsfield webhook hints', () => {
  it('accepts a known token as a hint and ignores caller-supplied status', async () => {
    const repository = await seededRepository();
    const { handle, nudged } = handlerFor(repository);
    const response = await handle({
      method: 'POST',
      query: { token },
      headers: {},
      body: { status: 'completed', request_id: 'attacker-supplied', images: [{ url: 'https://evil.example.com/x.png' }] }
    });
    expect(response.status).toBe(202);
    expect(nudged).toEqual(['job_bound']);
  });

  it('rejects an unknown or missing token without any provider work', async () => {
    const repository = await seededRepository();
    const { handle, nudged } = handlerFor(repository);
    const unknown = await handle({ method: 'POST', query: { token: newOpaqueToken(32) }, headers: {}, body: {} });
    const missing = await handle({ method: 'POST', query: {}, headers: {}, body: {} });
    const otherMethod = await handle({ method: 'GET', query: { token }, headers: {}, body: undefined });
    expect(unknown.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(otherMethod.status).toBe(405);
    expect(nudged).toHaveLength(0);
  });

  it('bounds the body and the notification rate per token', async () => {
    const repository = await seededRepository();
    const { handle } = handlerFor(repository);
    const oversized = await handle({ method: 'POST', query: { token }, headers: {}, body: {}, bodyBytes: 70_000 });
    expect(oversized.status).toBe(413);

    let limited = 0;
    for (let attempt = 0; attempt < 61; attempt += 1) {
      const response = await handle({ method: 'POST', query: { token }, headers: {}, body: {} });
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
