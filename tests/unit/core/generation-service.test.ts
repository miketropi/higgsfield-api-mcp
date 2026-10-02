import { describe, expect, it } from 'vitest';
import type { GenerationJob, MediaIdentity, MediaReference } from '@higgsfield-mcp/core';
import { createFakeMediaService } from '../../fixtures/fakes.js';
import type { FakeProviderOptions } from '../../fixtures/fakes.js';
import { createTestStack, submitJob } from '../../fixtures/stack.js';
import type { TestStackOptions } from '../../fixtures/stack.js';
import { createMemoryJobRepository } from '@higgsfield-mcp/core';
import type { JobRepository } from '@higgsfield-mcp/core';

const generate = (input: Record<string, unknown> = { prompt: 'a lighthouse' }): { endpoint: string; input: Record<string, unknown> } => ({
  endpoint: 'image.default',
  input
});

describe('generation admission', () => {
  it('reuses the stored job for the same idempotency key without re-uploading media', async () => {
    let uploads = 0;
    let identifies = 0;
    const media = createFakeMediaService({
      async resolve(reference: MediaReference) {
        uploads += 1;
        return {
          id: 'asset_1',
          tenantId: 'tenant-a',
          provider: 'higgsfield',
          mediaType: 'image',
          mimeType: 'image/png',
          url: `https://cdn.example.com/${reference.type}.png`,
          createdAt: new Date().toISOString(),
          origin: 'upload'
        };
      },
      async identify(reference: MediaReference): Promise<MediaIdentity> {
        identifies += 1;
        return { kind: reference.type === 'asset' ? 'asset' : 'url', id: 'stable-identity', mediaType: 'image' };
      }
    });
    const stack = createTestStack({ media });
    const request = {
      ...generate({ prompt: 'a lighthouse', reference_images: [{ type: 'url' as const, url: 'https://cdn.example.com/in.png' }] }),
      idempotencyKey: 'key-1'
    };
    const first = await submitJob(stack, 'higgsfield.generate_image', request);
    const second = await submitJob(stack, 'higgsfield.generate_image', request);
    expect(second.id).toBe(first.id);
    expect(uploads).toBe(1);
    expect(identifies).toBe(2);
  });

  it('rejects the same key with different normalized input and submits nothing extra', async () => {
    const stack = createTestStack();
    await submitJob(stack, 'higgsfield.generate_image', { ...generate(), idempotencyKey: 'key-2' });
    await expect(
      submitJob(stack, 'higgsfield.generate_image', { ...generate({ prompt: 'different' }), idempotencyKey: 'key-2' })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const jobs = await stack.repository.transaction((tx) => tx.listJobs('tenant-a', { limit: 10 }));
    expect(jobs.jobs).toHaveLength(1);
  });

  it('requires explicit confirmation above the threshold and creates no reservation', async () => {
    const stack = createTestStack({ provider: { estimateMicroUsd: 8_400_000 }, cost: { requireConfirmAboveUsd: 1 } });
    const result = await stack.generation.submit('higgsfield.generate_image', generate(), {
      requestId: 'req_1',
      tenantId: 'tenant-a',
      transport: 'stdio'
    });
    expect(result).toMatchObject({ status: 'confirmation_required', estimatedCostUsd: 8.4 });
    if (result.status !== 'confirmation_required') throw new Error('expected confirmation');
    expect(stack.provider.submitCount()).toBe(0);
    const jobs = await stack.repository.transaction((tx) => tx.listJobs('tenant-a', { limit: 10 }));
    expect(jobs.jobs).toHaveLength(0);

    const confirmed = await submitJob(stack, 'higgsfield.generate_image', {
      ...generate(),
      confirmationToken: result.confirmationToken
    });
    expect(confirmed.status).toBe('queued');

    await expect(
      submitJob(stack, 'higgsfield.generate_image', { ...generate(), confirmationToken: result.confirmationToken })
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
  });

  it('refuses an expired or foreign confirmation token', async () => {
    const stack = createTestStack({ provider: { estimateMicroUsd: 8_400_000 }, cost: { requireConfirmAboveUsd: 1 } });
    const result = await stack.generation.submit('higgsfield.generate_image', generate(), {
      requestId: 'req_1',
      tenantId: 'tenant-a',
      transport: 'stdio'
    });
    if (result.status !== 'confirmation_required') throw new Error('expected confirmation');
    await expect(
      stack.generation.submit(
        'higgsfield.generate_image',
        { ...generate(), confirmationToken: result.confirmationToken },
        { requestId: 'req_1', tenantId: 'tenant-b', transport: 'stdio' }
      )
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });

    stack.clock.advance(11 * 60 * 1000);
    await expect(
      submitJob(stack, 'higgsfield.generate_image', { ...generate(), confirmationToken: result.confirmationToken })
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
  });

  it('rejects a confirmed request whose price increased', async () => {
    const providerOptions: FakeProviderOptions = { estimateMicroUsd: 2_000_000 };
    const stack = createTestStack({ provider: providerOptions, cost: { requireConfirmAboveUsd: 1 } });
    const result = await stack.generation.submit('higgsfield.generate_image', generate(), {
      requestId: 'req_1',
      tenantId: 'tenant-a',
      transport: 'stdio'
    });
    if (result.status !== 'confirmation_required') throw new Error('expected confirmation');
    providerOptions.estimateMicroUsd = 5_000_000;
    await expect(
      submitJob(stack, 'higgsfield.generate_image', { ...generate(), confirmationToken: result.confirmationToken })
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });
  });

  it('enforces the per-job and daily cost ceilings', async () => {
    const perJob = createTestStack({ provider: { estimateMicroUsd: 2_000_000 }, cost: { maxJobCostUsd: 1 } });
    await expect(submitJob(perJob, 'higgsfield.generate_image', generate())).rejects.toMatchObject({
      code: 'COST_LIMIT_EXCEEDED'
    });

    const daily = createTestStack({ provider: { estimateMicroUsd: 60_000_000 }, cost: { dailyCostLimitUsd: 100 } });
    await submitJob(daily, 'higgsfield.generate_image', generate());
    await expect(submitJob(daily, 'higgsfield.generate_image', generate())).rejects.toMatchObject({
      code: 'COST_LIMIT_EXCEEDED'
    });
  });

  it('fails closed when pricing is unknown and a cost control is configured', async () => {
    const stack = createTestStack({ cost: { maxJobCostUsd: 5 } });
    await expect(submitJob(stack, 'higgsfield.generate_image', generate())).rejects.toMatchObject({
      code: 'POLICY_REJECTED'
    });
    const permissive = createTestStack();
    const job: GenerationJob = await submitJob(permissive, 'higgsfield.generate_image', generate());
    expect(job.cost).toBeUndefined();
  });

  it('issues an upstream idempotency key and freezes the provider body before submission', async () => {
    const stack = createTestStack();
    const job = await submitJob(stack, 'higgsfield.generate_image', generate({ prompt: 'frozen' }));
    const envelope = await stack.repository.transaction((tx) => tx.getSubmission('tenant-a', job.id));
    expect(envelope?.upstreamIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(envelope?.body).toEqual({ prompt: 'frozen' });
    expect(envelope?.bodyHash).toHaveLength(64);
    const prepareCalls = stack.provider.calls.filter((call) => call.kind === 'prepare');
    expect(prepareCalls).toHaveLength(1);
  });

  it('refuses a caller-supplied webhook that the gateway does not own and uses its own callback when it does', async () => {
    const disabled = createTestStack();
    await expect(
      submitJob(disabled, 'higgsfield.generate', {
        endpoint: 'xai/grok-imagine-image-2.0',
        input: { prompt: 'x' },
        webhook: { url: 'https://attacker.example.com/collect' }
      })
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });

    const gatewayUrl = 'https://gateway.test.example/webhooks/higgsfield';
    const stack = createTestStack({
      webhook: {
        callbackUrl: (_jobId: string, token: string) => `${gatewayUrl}?token=${token}`,
        ownsUrl: (supplied: string) => supplied.startsWith(gatewayUrl)
      }
    });
    await expect(
      submitJob(stack, 'higgsfield.generate', {
        endpoint: 'xai/grok-imagine-image-2.0',
        input: { prompt: 'x' },
        webhook: { url: 'https://attacker.example.com/collect' }
      })
    ).rejects.toMatchObject({ code: 'POLICY_REJECTED' });

    const accepted = await submitJob(stack, 'higgsfield.generate', {
      endpoint: 'xai/grok-imagine-image-2.0',
      input: { prompt: 'x' },
      webhook: { url: `${gatewayUrl}?token=caller-supplied` }
    });
    const envelope = await stack.repository.transaction((tx) => tx.getSubmission('tenant-a', accepted.id));
    // The gateway never transmits a caller-supplied token: it substitutes its own.
    expect(envelope?.callbackToken).toBeDefined();
    expect(envelope?.callbackTokenHash).toHaveLength(64);
    expect(envelope?.query?.['hf_webhook']).toContain('token=');
    expect(envelope?.query?.['hf_webhook']).not.toContain('caller-supplied');
    expect(envelope?.webhookUrl).toContain(gatewayUrl);
  });

  it('rolls back the losing side of an idempotency race and reuses the winner job', async () => {
    const base = createMemoryJobRepository();
    const winnerId = 'job_winner';
    const winner: GenerationJob = {
      id: winnerId,
      tenantId: 'tenant-a',
      provider: 'higgsfield',
      capability: 'image_generation',
      kind: 'generation',
      status: 'queued',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      inputSummary: {},
      assets: [],
      submissionState: 'pending',
      tool: 'higgsfield.generate_image',
      concurrencyClass: 'image'
    };
    await base.transaction((tx) => tx.insertJob(winner));
    // Simulates the PostgreSQL adapter: the claim reports the row a concurrent
    // transaction inserted first instead of silently overwriting it.
    const racing: JobRepository = {
      ...base,
      transaction: async (fn) =>
        base.transaction((tx) =>
          fn({
            ...tx,
            async putIdempotency(record) {
              await tx.putIdempotency({ ...record, jobId: winnerId });
              return { ...record, jobId: winnerId };
            }
          })
        )
    };
    const stack = createTestStack({ repository: racing } satisfies TestStackOptions);
    const reused = await submitJob(stack, 'higgsfield.generate_image', {
      ...generate({ prompt: 'contended' }),
      idempotencyKey: 'raced-key'
    });
    expect(reused.id).toBe(winnerId);

    const jobs = await base.transaction((tx) => tx.listJobs('tenant-a', { limit: 10 }));
    expect(jobs.jobs.map((entry) => entry.id)).toEqual([winnerId]);
    const envelope = await base.transaction((tx) => tx.getSubmission('tenant-a', winnerId));
    expect(envelope).toBeUndefined();
  });

  it('re-signs managed assets when a job is read', async () => {
    const refreshed: string[] = [];
    const stack = createTestStack({
      jobsAssets: {
        async refresh(job) {
          refreshed.push(job.id);
          return job.assets.map((asset) => ({ ...asset, url: `${asset.url}?re-signed=1` }));
        }
      }
    });
    const job = await submitJob(stack, 'higgsfield.generate_image', generate());
    await stack.worker.runOnce();
    stack.clock.advance(30_000);
    await stack.worker.runOnce();
    const read = await stack.jobs.get(job.id, { requestId: 'req', tenantId: 'tenant-a', transport: 'stdio' });
    expect(refreshed).toContain(job.id);
    expect(read.assets[0]?.url).toContain('re-signed=1');
  });

  it('treats a changed caller media URL as different intent while keeping the stored envelope immutable', async () => {
    const stack = createTestStack();
    const first = await submitJob(stack, 'higgsfield.generate_image', {
      ...generate({ prompt: 'stable', reference_images: [{ type: 'url' as const, url: 'https://cdn.example.com/a.png' }] }),
      idempotencyKey: 'key-3'
    });
    await expect(
      submitJob(stack, 'higgsfield.generate_image', {
        ...generate({ prompt: 'stable', reference_images: [{ type: 'url' as const, url: 'https://cdn.example.com/b.png' }] }),
        idempotencyKey: 'key-3'
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const frozen = await stack.repository.transaction((tx) => tx.getSubmission('tenant-a', first.id));
    await stack.repository.transaction((tx) =>
      tx.updateAsset('tenant-a', first.id, { url: 'https://cdn.example.com/re-signed.png' })
    );
    const again = await stack.repository.transaction((tx) => tx.getSubmission('tenant-a', first.id));
    expect(again?.body).toEqual(frozen?.body);
    expect(again?.bodyHash).toBe(frozen?.bodyHash);
  });
});
