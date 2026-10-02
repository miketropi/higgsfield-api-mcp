import { describe, expect, it } from 'vitest';
import type { GenerationJob, MediaAsset } from '@higgsfield-mcp/core';
import { createMemoryJobRepository, GatewayError } from '@higgsfield-mcp/core';

const job = (id: string, tenantId = 'tenant-a', createdAt = '2026-10-01T00:00:00.000Z'): GenerationJob => ({
  id,
  tenantId,
  provider: 'higgsfield',
  capability: 'image_generation',
  kind: 'generation',
  status: 'queued',
  createdAt,
  updatedAt: createdAt,
  inputSummary: {},
  assets: [],
  submissionState: 'pending',
  tool: 'higgsfield.generate_image',
  concurrencyClass: 'image'
});

const envelope = (jobId: string, tenantId = 'tenant-a') => ({
  jobId,
  tenantId,
  provider: 'higgsfield',
  providerAccountId: 'acct',
  jobKind: 'generation' as const,
  concurrencyClass: 'image' as const,
  endpoint: 'xai/grok-imagine-image-2.0',
  upstreamIdempotencyKey: `11111111-1111-1111-1111-${jobId.slice(-12).padStart(12, '0')}`,
  body: { prompt: 'x' },
  bodyHash: 'a'.repeat(64),
  state: 'pending' as const,
  attempts: 0,
  version: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z'
});

describe('memory job repository', () => {
  it('rolls the whole transaction back when the callback throws', async () => {
    const repository = createMemoryJobRepository();
    await expect(
      repository.transaction(async (tx) => {
        await tx.insertJob(job('job_rollback'));
        throw new GatewayError('INVALID_INPUT', 'nope');
      })
    ).rejects.toThrow(GatewayError);
    const found = await repository.transaction((tx) => tx.getJob('tenant-a', 'job_rollback'));
    expect(found).toBeUndefined();
  });

  it('hides other tenants jobs and enforces compare-and-set updates', async () => {
    const repository = createMemoryJobRepository();
    await repository.transaction(async (tx) => {
      await tx.insertJob(job('job_1'));
    });
    const foreign = await repository.transaction((tx) => tx.getJob('tenant-b', 'job_1'));
    expect(foreign).toBeUndefined();

    const stale = await repository.transaction((tx) =>
      tx.updateJob('tenant-a', 'job_1', { status: 'completed', updatedAt: 'later' }, { expectStatus: ['processing'] })
    );
    expect(stale).toBeUndefined();
    const applied = await repository.transaction((tx) =>
      tx.updateJob('tenant-a', 'job_1', { status: 'processing', updatedAt: 'later' }, { expectStatus: ['queued'] })
    );
    expect(applied?.status).toBe('processing');
    expect(applied?.updatedAt).toBe('later');
  });

  it('rejects an idempotency key reused with a different request hash', async () => {
    const repository = createMemoryJobRepository();
    await repository.transaction((tx) =>
      tx.putIdempotency({
        tenantId: 'tenant-a',
        tool: 't',
        key: 'k',
        requestHash: 'h1',
        jobId: 'job_1',
        createdAt: 'now'
      })
    );
    const same = await repository.transaction((tx) =>
      tx.putIdempotency({
        tenantId: 'tenant-a',
        tool: 't',
        key: 'k',
        requestHash: 'h1',
        jobId: 'job_2',
        createdAt: 'now'
      })
    );
    expect(same.jobId).toBe('job_1');
    await expect(
      repository.transaction((tx) =>
        tx.putIdempotency({
          tenantId: 'tenant-a',
          tool: 't',
          key: 'k',
          requestHash: 'h2',
          jobId: 'job_3',
          createdAt: 'now'
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const otherTenant = await repository.transaction((tx) =>
      tx.putIdempotency({
        tenantId: 'tenant-b',
        tool: 't',
        key: 'k',
        requestHash: 'h2',
        jobId: 'job_4',
        createdAt: 'now'
      })
    );
    expect(otherTenant.jobId).toBe('job_4');
  });

  it('leases claims atomically and honours the per-class ceiling', async () => {
    const repository = createMemoryJobRepository();
    await repository.transaction(async (tx) => {
      await tx.insertJob(job('job_1'));
      await tx.insertJob(job('job_2'));
      await tx.putSubmission(envelope('job_1'));
      await tx.putSubmission(envelope('job_2'));
    });
    const claimed = await repository.transaction((tx) =>
      tx.claimSubmissions({
        owner: 'w1',
        leaseTtlMs: 1_000,
        now: '2026-10-01T00:00:01.000Z',
        batchLimit: 10,
        maxPerClass: { image: 1, video: 1, other: 1 }
      })
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.state).toBe('submitting');
    const blocked = await repository.transaction((tx) =>
      tx.claimSubmissions({
        owner: 'w2',
        leaseTtlMs: 1_000,
        now: '2026-10-01T00:00:01.500Z',
        batchLimit: 10,
        maxPerClass: { image: 1, video: 1, other: 1 }
      })
    );
    expect(blocked).toHaveLength(0);
    const afterExpiry = await repository.transaction((tx) =>
      tx.claimSubmissions({
        owner: 'w2',
        leaseTtlMs: 1_000,
        now: '2026-10-01T00:00:05.000Z',
        batchLimit: 10,
        maxPerClass: { image: 1, video: 1, other: 1 }
      })
    );
    expect(afterExpiry).toHaveLength(1);
    expect(afterExpiry[0]?.leaseOwner).toBe('w2');
  });

  it('consumeConfirmation is single-use and usage settlement is unique', async () => {
    const repository = createMemoryJobRepository();
    await repository.transaction(async (tx) => {
      await tx.putConfirmation({
        tokenHash: 'hash',
        tenantId: 'tenant-a',
        tool: 't',
        requestHash: 'r',
        estimatedMicroUsd: 1,
        expiresAt: '2030-01-01T00:00:00.000Z',
        createdAt: '2026-10-01T00:00:00.000Z'
      });
    });
    const first = await repository.transaction((tx) => tx.consumeConfirmation('hash', '2026-10-01T00:00:01.000Z'));
    const second = await repository.transaction((tx) => tx.consumeConfirmation('hash', '2026-10-01T00:00:02.000Z'));
    expect(first?.tokenHash).toBe('hash');
    expect(second).toBeUndefined();

    await repository.transaction(async (tx) => {
      await tx.reserveUsage({
        jobId: 'job_1',
        tenantId: 'tenant-a',
        day: '2026-10-01',
        microUsd: 100,
        providerAccountId: 'acct',
        state: 'reserved',
        createdAt: '2026-10-01T00:00:00.000Z'
      });
    });
    await repository.transaction((tx) => tx.settleUsage('job_1', 90, '2026-10-01T00:00:05.000Z'));
    await repository.transaction((tx) => tx.settleUsage('job_1', 500, '2026-10-01T00:00:06.000Z'));
    const reservation = await repository.transaction((tx) => tx.getReservation('job_1'));
    expect(reservation?.state).toBe('settled');
    expect(reservation?.settledMicroUsd).toBe(90);
    // Committed spend for the day keeps the settled amount: a completed job must not
    // free budget for the rest of the UTC day.
    const committed = await repository.transaction((tx) => tx.reservedMicroUsdForDay('tenant-a', '2026-10-01'));
    expect(committed).toBe(90);
  });

  it('keeps a cancelled job with live provider work reconcilable', async () => {
    const repository = createMemoryJobRepository();
    await repository.transaction(async (tx) => {
      await tx.insertJob({
        ...job('job_cancelled'),
        status: 'cancelled',
        submissionState: 'acknowledged',
        metadata: { cancellation_pending_reconcile: true }
      });
      await tx.insertJob({ ...job('job_done'), status: 'completed', submissionState: 'acknowledged' });
    });
    const reconcilable = await repository.transaction((tx) => tx.listReconcilableJobs(10));
    expect(reconcilable.map((entry) => entry.id)).toEqual(['job_cancelled']);
  });

  it('paginates jobs newest first with an opaque cursor and scopes assets by tenant', async () => {
    const repository = createMemoryJobRepository();
    await repository.transaction(async (tx) => {
      await tx.insertJob(job('job_1', 'tenant-a', '2026-10-01T00:00:01.000Z'));
      await tx.insertJob(job('job_2', 'tenant-a', '2026-10-01T00:00:02.000Z'));
      await tx.insertJob(job('job_3', 'tenant-a', '2026-10-01T00:00:03.000Z'));
    });
    const page1 = await repository.transaction((tx) => tx.listJobs('tenant-a', { limit: 2 }));
    expect(page1.jobs.map((entry) => entry.id)).toEqual(['job_3', 'job_2']);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await repository.transaction((tx) =>
      tx.listJobs('tenant-a', { limit: 2, cursor: page1.nextCursor as string })
    );
    expect(page2.jobs.map((entry) => entry.id)).toEqual(['job_1']);

    const asset: MediaAsset = {
      id: 'asset_1',
      tenantId: 'tenant-a',
      provider: 'higgsfield',
      mediaType: 'image',
      mimeType: 'image/png',
      url: 'https://cdn.example.com/a.png',
      createdAt: '2026-10-01T00:00:00.000Z',
      origin: 'provider'
    };
    await repository.transaction((tx) => tx.insertAsset(asset));
    expect(await repository.transaction((tx) => tx.getAsset('tenant-b', 'asset_1'))).toBeUndefined();
    expect((await repository.transaction((tx) => tx.getAsset('tenant-a', 'asset_1')))?.id).toBe('asset_1');
  });

  it('stores copies so callers cannot mutate persisted state', async () => {
    const repository = createMemoryJobRepository();
    const source = job('job_1');
    await repository.transaction((tx) => tx.insertJob(source));
    source.status = 'completed';
    const stored = await repository.transaction((tx) => tx.getJob('tenant-a', 'job_1'));
    expect(stored?.status).toBe('queued');
    if (stored !== undefined) stored.status = 'failed';
    const reread = await repository.transaction((tx) => tx.getJob('tenant-a', 'job_1'));
    expect(reread?.status).toBe('queued');
  });
});
