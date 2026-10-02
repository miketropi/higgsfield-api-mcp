/**
 * PostgreSQL repository contract, run against a disposable database
 * (`HF_MCP_TEST_DATABASE_URL`). Each test owns its own tenant inside a freshly
 * created schema, so the suite is order-independent and repeatable.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayError, createPostgresJobRepository, runMigrations } from '@higgsfield-mcp/core';
import type {
  ConfirmationRecord,
  GenerationJob,
  JobRepository,
  LoggerPort,
  MediaAsset,
  SubmissionEnvelope,
  UsageReservation
} from '@higgsfield-mcp/core';
import {
  TEST_DATABASE_URL,
  announceSkip,
  createTestSchema,
  firstRow,
  rawClient,
  rowsOf,
  silentLogger,
  uniqueSuffix
} from './support/services.js';
import type { TestSchema } from './support/services.js';

const SUITE = 'PostgreSQL job repository';
if (TEST_DATABASE_URL === undefined) announceSkip(SUITE, 'HF_MCP_TEST_DATABASE_URL');

const ENCRYPTION_KEY = new Uint8Array(randomBytes(32));
const WRONG_KEY = new Uint8Array(randomBytes(32));
const AT = '2026-10-02T10:00:00.000Z';
const AT_LATER = '2026-10-02T10:05:00.000Z';
const NOW = '2026-10-02T12:00:00.000Z';
const SUFFIX = uniqueSuffix();

/** Every test gets its own tenant: no cross-test interference without cleanups. */
function tenant(name: string): string {
  return `t_${name}_${SUFFIX}`;
}

function encodeCursorValue(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function makeJob(tenantId: string, id: string, overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id,
    tenantId,
    provider: 'higgsfield',
    capability: 'image_generation',
    kind: 'generation',
    status: 'queued',
    createdAt: AT,
    updatedAt: AT,
    inputSummary: { prompt: 'a cat' },
    assets: [],
    submissionState: 'pending',
    tool: 'higgsfield.generate_image',
    concurrencyClass: 'image',
    ...overrides
  };
}

function makeAsset(tenantId: string, id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    tenantId,
    provider: 'higgsfield',
    mediaType: 'image',
    mimeType: 'image/png',
    url: 'https://cdn.example.com/out.png',
    createdAt: AT,
    origin: 'provider',
    ...overrides
  };
}

function makeSubmission(
  tenantId: string,
  jobId: string,
  overrides: Partial<SubmissionEnvelope> = {}
): SubmissionEnvelope {
  return {
    jobId,
    tenantId,
    provider: 'higgsfield',
    providerAccountId: 'acct-1',
    jobKind: 'generation',
    concurrencyClass: 'image',
    endpoint: 'kling-video/v2.5-turbo/pro/image-to-video',
    upstreamIdempotencyKey: `upstream-${jobId}`,
    body: { prompt: 'a cat', image_url: 'https://cdn.example.com/cat.png' },
    bodyHash: 'a'.repeat(64),
    state: 'pending',
    attempts: 0,
    version: 0,
    createdAt: AT,
    updatedAt: AT,
    ...overrides
  };
}

describe.skipIf(TEST_DATABASE_URL === undefined)(SUITE, () => {
  let schema: TestSchema;
  let repository: JobRepository;
  let connectionString: string;
  let logger: LoggerPort;
  const schemas: TestSchema[] = [];

  beforeAll(async () => {
    if (TEST_DATABASE_URL === undefined) throw new Error('HF_MCP_TEST_DATABASE_URL is required');
    logger = silentLogger();
    schema = await createTestSchema(TEST_DATABASE_URL);
    schemas.push(schema);
    connectionString = schema.connectionString;
    const migrated = await runMigrations({ connectionString, logger });
    expect(migrated.applied).toContain('0001_init.sql');
    repository = createPostgresJobRepository({ connectionString, logger, encryptionKey: ENCRYPTION_KEY });
    await repository.health();
  });

  afterAll(async () => {
    await repository?.close();
    await Promise.all(schemas.splice(0).map((created) => created.dispose()));
  });

  /**
   * `claimSubmissions` deliberately scans every tenant (the worker claims for the
   * whole provider account), so the claiming tests run in their own schema where
   * the candidate set contains exactly their own envelopes.
   */
  async function isolatedRepository(): Promise<{ repository: JobRepository; dispose: () => Promise<void> }> {
    if (TEST_DATABASE_URL === undefined) throw new Error('HF_MCP_TEST_DATABASE_URL is required');
    const isolated = await createTestSchema(TEST_DATABASE_URL);
    schemas.push(isolated);
    await runMigrations({ connectionString: isolated.connectionString, logger });
    const isolatedRepo = createPostgresJobRepository({
      connectionString: isolated.connectionString,
      logger,
      encryptionKey: ENCRYPTION_KEY
    });
    return {
      repository: isolatedRepo,
      async dispose() {
        await isolatedRepo.close();
      }
    };
  }

  it('runs no DDL until migrate() is called explicitly', async () => {
    if (TEST_DATABASE_URL === undefined) throw new Error('HF_MCP_TEST_DATABASE_URL is required');
    const isolated = await createTestSchema(TEST_DATABASE_URL);
    schemas.push(isolated);
    const unmigrated = createPostgresJobRepository({
      connectionString: isolated.connectionString,
      logger,
      encryptionKey: ENCRYPTION_KEY
    });
    try {
      // No tables exist yet: a domain call fails, so the constructor ran no DDL.
      await expect(
        unmigrated.transaction(async (tx) => tx.getJob(tenant('ddl'), 'job_none'))
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

      await unmigrated.migrate();

      await expect(unmigrated.health()).resolves.toBeUndefined();
      await expect(
        unmigrated.transaction(async (tx) => tx.getJob(tenant('ddl'), 'job_none'))
      ).resolves.toBeUndefined();
    } finally {
      await unmigrated.close();
    }
  });

  it('reports its kind and answers health checks', async () => {
    expect(repository.kind).toBe('postgres');
    await expect(repository.health()).resolves.toBeUndefined();
  });

  it('round-trips a job, rejects a duplicate id, and scopes reads by tenant', async () => {
    const owner = tenant('jobs');
    const other = tenant('jobs_other');
    const job = makeJob(owner, 'job_roundtrip', {
      workspaceId: 'ws-1',
      providerJobId: 'generation:abc',
      model: 'kling-video/v2.5-turbo/pro/image-to-video',
      endpoint: 'kling-video/v2.5-turbo/pro/image-to-video',
      progress: 0.25,
      cost: { currency: 'USD', estimatedMicroUsd: 12345, source: 'estimate_api' },
      metadata: { provider_status: 'queued' },
      assets: [makeAsset(owner, 'asset_1')]
    });

    await repository.transaction(async (tx) => tx.insertJob(job));

    const stored = await repository.transaction(async (tx) => tx.getJob(owner, job.id));
    expect(stored).toEqual(job);
    await expect(repository.transaction(async (tx) => tx.insertJob(job))).rejects.toMatchObject({
      code: 'INTERNAL_ERROR'
    });
    await expect(repository.transaction(async (tx) => tx.getJob(other, job.id))).resolves.toBeUndefined();
  });

  it('rolls the transaction back when the caller throws', async () => {
    const owner = tenant('rollback');
    const job = makeJob(owner, 'job_rollback');

    await expect(
      repository.transaction(async (tx) => {
        await tx.insertJob(job);
        throw new GatewayError('INTERNAL_ERROR', 'boom');
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    await expect(repository.transaction(async (tx) => tx.getJob(owner, job.id))).resolves.toBeUndefined();
  });

  it('pages jobs newest-first with a keyset cursor', async () => {
    const owner = tenant('pages');
    const jobs = [
      makeJob(owner, 'job_page_1', { createdAt: '2026-10-02T10:00:01.000Z', updatedAt: '2026-10-02T10:00:01.000Z' }),
      makeJob(owner, 'job_page_2', { createdAt: '2026-10-02T10:00:02.000Z', updatedAt: '2026-10-02T10:00:02.000Z' }),
      makeJob(owner, 'job_page_3', { createdAt: '2026-10-02T10:00:03.000Z', updatedAt: '2026-10-02T10:00:03.000Z' })
    ];
    await repository.transaction(async (tx) => {
      for (const job of jobs) await tx.insertJob(job);
    });

    const first = await repository.transaction(async (tx) => tx.listJobs(owner, { limit: 2 }));
    expect(first.jobs.map((job) => job.id)).toEqual(['job_page_3', 'job_page_2']);
    expect(first.nextCursor).toBeDefined();

    const second = await repository.transaction(async (tx) =>
      tx.listJobs(owner, { limit: 2, ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }) })
    );
    expect(second.jobs.map((job) => job.id)).toEqual(['job_page_1']);
    expect(second.nextCursor).toBeUndefined();

    const unknownCursor = await repository.transaction(async (tx) =>
      tx.listJobs(owner, { limit: 2, cursor: encodeCursorValue('job_does_not_exist') })
    );
    expect(unknownCursor.jobs).toEqual([]);
  });

  it('lists reconcilable jobs across tenants and only non-terminal ones', async () => {
    const ownerA = tenant('reconcile_a');
    const ownerB = tenant('reconcile_b');
    await repository.transaction(async (tx) => {
      await tx.insertJob(makeJob(ownerA, 'job_rec_queued', { status: 'queued' }));
      await tx.insertJob(makeJob(ownerB, 'job_rec_processing', { status: 'processing' }));
      await tx.insertJob(makeJob(ownerA, 'job_rec_completed', { status: 'completed' }));
      await tx.insertJob(makeJob(ownerB, 'job_rec_failed', { status: 'failed' }));
      await tx.insertJob(makeJob(ownerA, 'job_rec_cancelled', { status: 'cancelled' }));
    });

    const reconcilable = await repository.transaction(async (tx) => tx.listReconcilableJobs(50));
    const ids = reconcilable.map((job) => job.id);
    expect(ids).toContain('job_rec_queued');
    expect(ids).toContain('job_rec_processing');
    expect(ids).not.toContain('job_rec_completed');
    expect(ids).not.toContain('job_rec_failed');
    expect(ids).not.toContain('job_rec_cancelled');
    const mine = reconcilable.filter((job) => job.tenantId === ownerA || job.tenantId === ownerB);
    expect(mine.map((job) => job.id).sort()).toEqual(['job_rec_processing', 'job_rec_queued']);
  });

  it('reconciles cancellations the provider already acknowledged', async () => {
    const owner = tenant('reconcile_cancel');
    await repository.transaction(async (tx) => {
      await tx.insertJob(
        makeJob(owner, 'job_rec_cancelled_ack', { status: 'cancelled', submissionState: 'acknowledged' })
      );
      await tx.insertJob(
        makeJob(owner, 'job_rec_cancelled_pending', { status: 'cancelled', submissionState: 'pending' })
      );
      await tx.insertJob(
        makeJob(owner, 'job_rec_cancelled_rejected', { status: 'cancelled', submissionState: 'rejected' })
      );
      await tx.insertJob(makeJob(owner, 'job_rec_queued_ack', { status: 'queued', submissionState: 'acknowledged' }));
    });

    const ids = (await repository.transaction(async (tx) => tx.listReconcilableJobs(50))).map((job) => job.id);

    // The provider may still be running the acknowledged job, so its usage has to
    // settle or release rather than stay reserved for the rest of the UTC day.
    expect(ids).toContain('job_rec_cancelled_ack');
    expect(ids).toContain('job_rec_queued_ack');
    expect(ids).not.toContain('job_rec_cancelled_pending');
    expect(ids).not.toContain('job_rec_cancelled_rejected');
  });

  it('treats a failed compare-and-set guard as "no transition" and leaves the row unchanged', async () => {
    const owner = tenant('cas');
    const job = makeJob(owner, 'job_cas', { status: 'queued' });
    await repository.transaction(async (tx) => tx.insertJob(job));

    const staleStatus = await repository.transaction(async (tx) =>
      tx.updateJob(owner, job.id, { status: 'cancelled', updatedAt: AT_LATER }, { expectStatus: ['completed'] })
    );
    expect(staleStatus).toBeUndefined();

    const staleSubmission = await repository.transaction(async (tx) =>
      tx.updateJob(owner, job.id, { status: 'cancelled', updatedAt: AT_LATER }, {
        expectSubmissionState: ['acknowledged']
      })
    );
    expect(staleSubmission).toBeUndefined();

    const missing = await repository.transaction(async (tx) =>
      tx.updateJob(owner, 'job_missing', { updatedAt: AT_LATER }, {})
    );
    expect(missing).toBeUndefined();

    const unchanged = await repository.transaction(async (tx) => tx.getJob(owner, job.id));
    expect(unchanged?.status).toBe('queued');
    expect(unchanged?.updatedAt).toBe(AT);

    const updated = await repository.transaction(async (tx) =>
      tx.updateJob(owner, job.id, { status: 'processing', progress: 0.5, updatedAt: AT_LATER }, {
        expectStatus: ['queued'],
        expectSubmissionState: ['pending']
      })
    );
    expect(updated).toMatchObject({ status: 'processing', progress: 0.5, updatedAt: AT_LATER });
  });

  it('claims an idempotency key atomically and never overwrites the stored row', async () => {
    const owner = tenant('idem_race');
    const tool = 'higgsfield.generate_image';
    const key = 'key-race';
    const record = { tenantId: owner, tool, key, requestHash: 'hash-same', createdAt: AT };

    const put = (jobId: string) => repository.transaction(async (tx) => tx.putIdempotency({ ...record, jobId }));
    const [first, second] = await Promise.all([put('job_race_1'), put('job_race_2')]);

    // Exactly one caller wins the key; both observe the winner's row verbatim, so
    // the loser can compare and roll its own job back.
    expect(first.jobId).toBe(second.jobId);
    expect(first.requestHash).toBe('hash-same');
    expect(second.requestHash).toBe('hash-same');

    const client = await rawClient(connectionString);
    try {
      const stored = rowsOf(
        await client.query(
          'SELECT job_id FROM idempotency_keys WHERE tenant_id = $1 AND tool = $2 AND key = $3',
          [owner, tool, key]
        )
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.['job_id']).toBe(first.jobId);
    } finally {
      await client.end();
    }

    // A differing request hash is still a hard conflict, and still cannot mutate
    // the stored row.
    await expect(
      repository.transaction(async (tx) =>
        tx.putIdempotency({ ...record, jobId: 'job_race_3', requestHash: 'other' })
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const after = await repository.transaction(async (tx) => tx.getIdempotency(owner, tool, key));
    expect(after).toMatchObject({ jobId: first.jobId, requestHash: 'hash-same' });
  });

  it('returns the stored idempotency record and rejects a different request hash', async () => {
    const owner = tenant('idem');
    const record = {
      tenantId: owner,
      tool: 'higgsfield.generate_image',
      key: 'key-1',
      requestHash: 'hash-a',
      jobId: 'job_idem',
      createdAt: AT
    };

    const inserted = await repository.transaction(async (tx) => tx.putIdempotency(record));
    expect(inserted).toEqual(record);

    const replay = await repository.transaction(async (tx) => tx.putIdempotency(record));
    expect(replay).toEqual(record);

    await expect(
      repository.transaction(async (tx) => tx.putIdempotency({ ...record, requestHash: 'hash-b' }))
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'idempotency_key_mismatch' } });

    const stored = await repository.transaction(async (tx) =>
      tx.getIdempotency(owner, record.tool, record.key)
    );
    expect(stored?.requestHash).toBe('hash-a');
  });

  it('stores submission secrets as authenticated ciphertext that needs the key', async () => {
    const owner = tenant('secrets');
    const jobId = 'job_secrets';
    const canary = `canary-${uniqueSuffix()}`;
    const envelope = makeSubmission(owner, jobId, {
      body: { prompt: canary, image_url: 'https://cdn.example.com/cat.png' },
      query: { hf_webhook: `https://hooks.example.com/${canary}` },
      webhookUrl: `https://hooks.example.com/${canary}`,
      callbackToken: `token-${canary}`,
      callbackTokenHash: 'f'.repeat(64)
    });
    await repository.transaction(async (tx) => tx.putSubmission(envelope));

    const client = await rawClient(connectionString);
    try {
      const row = firstRow(
        await client.query(
          'SELECT body, query_params, webhook_url, callback_token, callback_token_hash FROM submissions WHERE tenant_id = $1 AND job_id = $2',
          [owner, jobId]
        )
      );
      const body = String(row['body']);
      expect(body).not.toContain(canary);
      expect(body.startsWith('v1.')).toBe(true);
      expect(() => JSON.parse(body)).toThrow();
      expect(String(row['query_params'])).not.toContain(canary);
      expect(String(row['webhook_url'])).not.toContain(canary);
      expect(String(row['callback_token'])).not.toContain(canary);
      // The hash is the only callback material stored verbatim.
      expect(row['callback_token_hash']).toBe('f'.repeat(64));
    } finally {
      await client.end();
    }

    const loaded = await repository.transaction(async (tx) => tx.getSubmission(owner, jobId));
    expect(loaded?.body).toEqual(envelope.body);
    expect(loaded?.query).toEqual(envelope.query);
    expect(loaded?.webhookUrl).toBe(envelope.webhookUrl);
    expect(loaded?.callbackToken).toBe(envelope.callbackToken);

    const wrongKey = createPostgresJobRepository({
      connectionString,
      logger,
      encryptionKey: WRONG_KEY
    });
    try {
      await expect(wrongKey.transaction(async (tx) => tx.getSubmission(owner, jobId))).rejects.toMatchObject({
        code: 'INTERNAL_ERROR'
      });
    } finally {
      await wrongKey.close();
    }
  });

  it('accepts every documented submission state, including rejected and cancelled', async () => {
    const owner = tenant('states');
    const states = ['pending', 'submitting', 'acknowledged', 'outcome_unknown', 'rejected', 'cancelled'] as const;

    await repository.transaction(async (tx) => {
      for (const state of states) {
        const jobId = `job_state_${state}`;
        await tx.insertJob(makeJob(owner, jobId, { submissionState: state }));
        await tx.putSubmission(makeSubmission(owner, jobId, { state }));
      }
    });

    for (const state of states) {
      const stored = await repository.transaction(async (tx) => tx.getSubmission(owner, `job_state_${state}`));
      expect(stored?.state).toBe(state);
      const job = await repository.transaction(async (tx) => tx.getJob(owner, `job_state_${state}`));
      expect(job?.submissionState).toBe(state);
    }

    // The state guard is also writable through the CAS path.
    const updated = await repository.transaction(async (tx) =>
      tx.updateJob(owner, 'job_state_pending', { updatedAt: AT_LATER }, { expectSubmissionState: ['rejected'] })
    );
    expect(updated).toBeUndefined();
  });

  it('grants exactly one lease when two workers race for the same envelope', async () => {
    const owner = tenant('lease_race');
    const jobId = 'job_lease_race';
    const isolated = await isolatedRepository();
    try {
      const repo = isolated.repository;
      await repo.transaction(async (tx) => tx.putSubmission(makeSubmission(owner, jobId)));

      const claim = (leaseOwner: string) =>
        repo.transaction(async (tx) =>
          tx.claimSubmissions({
            owner: leaseOwner,
            leaseTtlMs: 30_000,
            now: NOW,
            batchLimit: 1,
            maxPerClass: { image: 10, video: 10, other: 10 }
          })
        );

      const [first, second] = await Promise.all([claim('worker-a'), claim('worker-b')]);
      expect(first.length + second.length).toBe(1);
      const winner = first.length === 1 ? first[0] : second[0];
      expect(winner?.jobId).toBe(jobId);
      expect(winner?.state).toBe('submitting');
      expect(winner?.version).toBe(1);
      expect(winner?.leaseOwner).toBe(first.length === 1 ? 'worker-a' : 'worker-b');

      const stored = await repo.transaction(async (tx) => tx.getSubmission(owner, jobId));
      expect(stored?.leaseOwner).toBe(winner?.leaseOwner);
      expect(stored?.leaseExpiresAt).toBe('2026-10-02T12:00:30.000Z');

      // A live lease is not claimable again.
      const third = await claim('worker-c');
      expect(third).toEqual([]);
    } finally {
      await isolated.dispose();
    }
  });

  it('honours per-concurrency-class ceilings inside the claiming transaction', async () => {
    const owner = tenant('ceilings');
    const isolated = await isolatedRepository();
    try {
      const repo = isolated.repository;
      await repo.transaction(async (tx) => {
        await tx.putSubmission(
          makeSubmission(owner, 'job_ceil_image_1', { createdAt: '2026-10-02T10:00:01.000Z' })
        );
        await tx.putSubmission(
          makeSubmission(owner, 'job_ceil_image_2', { createdAt: '2026-10-02T10:00:02.000Z' })
        );
        await tx.putSubmission(
          makeSubmission(owner, 'job_ceil_video', {
            concurrencyClass: 'video',
            createdAt: '2026-10-02T10:00:03.000Z'
          })
        );
      });

      const claim = (maxPerClass: { image: number; video: number; other: number }) =>
        repo.transaction(async (tx) =>
          tx.claimSubmissions({ owner: 'worker-ceiling', leaseTtlMs: 30_000, now: NOW, batchLimit: 10, maxPerClass })
        );

      const first = await claim({ image: 1, video: 0, other: 0 });
      expect(first.map((envelope) => envelope.jobId)).toEqual(['job_ceil_image_1']);

      // The image slot is taken, but the video class has room again.
      const second = await claim({ image: 1, video: 1, other: 0 });
      expect(second.map((envelope) => envelope.jobId)).toEqual(['job_ceil_video']);

      // Raising the image ceiling admits the second image, not a second video.
      const third = await claim({ image: 5, video: 1, other: 0 });
      expect(third.map((envelope) => envelope.jobId)).toEqual(['job_ceil_image_2']);
    } finally {
      await isolated.dispose();
    }
  });

  it('reclaims a lease that has expired', async () => {
    const owner = tenant('lease_expiry');
    const jobId = 'job_lease_expired';
    const isolated = await isolatedRepository();
    try {
      const repo = isolated.repository;
      await repo.transaction(async (tx) =>
        tx.putSubmission(
          makeSubmission(owner, jobId, {
            state: 'submitting',
            leaseOwner: 'worker-dead',
            leaseExpiresAt: '2026-10-02T11:00:00.000Z',
            version: 3
          })
        )
      );

      const claimed = await repo.transaction(async (tx) =>
        tx.claimSubmissions({
          owner: 'worker-alive',
          leaseTtlMs: 30_000,
          now: NOW,
          batchLimit: 1,
          maxPerClass: { image: 10, video: 10, other: 10 }
        })
      );

      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.leaseOwner).toBe('worker-alive');
      expect(claimed[0]?.version).toBe(4);
    } finally {
      await isolated.dispose();
    }
  });

  it('renews and releases leases only for the owning worker', async () => {
    const owner = tenant('lease_renew');
    const jobId = 'job_lease_renew';
    const isolated = await isolatedRepository();
    try {
      const repo = isolated.repository;
      await repo.transaction(async (tx) => tx.putSubmission(makeSubmission(owner, jobId)));
      await repo.transaction(async (tx) =>
        tx.claimSubmissions({
          owner: 'worker-a',
          leaseTtlMs: 30_000,
          now: NOW,
          batchLimit: 1,
          maxPerClass: { image: 10, video: 10, other: 10 }
        })
      );

      const stolen = await repo.transaction(async (tx) => tx.renewLease(jobId, 'worker-b', 5_000));
      expect(stolen).toBe(false);

      const renewed = await repo.transaction(async (tx) => tx.renewLease(jobId, 'worker-a', 5_000));
      expect(renewed).toBe(true);
      const afterRenew = await repo.transaction(async (tx) => tx.getSubmission(owner, jobId));
      expect(afterRenew?.leaseExpiresAt).toBe('2026-10-02T12:00:35.000Z');

      await repo.transaction(async (tx) => tx.releaseLease(jobId, 'worker-b'));
      const stillLeased = await repo.transaction(async (tx) => tx.getSubmission(owner, jobId));
      expect(stillLeased?.leaseOwner).toBe('worker-a');

      await repo.transaction(async (tx) => tx.releaseLease(jobId, 'worker-a'));
      const released = await repo.transaction(async (tx) => tx.getSubmission(owner, jobId));
      expect(released?.leaseOwner).toBeUndefined();
      expect(released?.leaseExpiresAt).toBeUndefined();

      await expect(
        repo.transaction(async (tx) => tx.renewLease('job_missing', 'worker-a', 1_000))
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    } finally {
      await isolated.dispose();
    }
  });

  it('settles usage idempotently and releases only reserved rows', async () => {
    const owner = tenant('usage');
    const day = '2026-10-02';
    const settledJob = 'job_usage_settled';
    const releasedJob = 'job_usage_released';
    const reservation = (jobId: string, microUsd: number): UsageReservation => ({
      jobId,
      tenantId: owner,
      day,
      microUsd,
      providerAccountId: 'acct-1',
      state: 'reserved',
      createdAt: AT
    });

    await repository.transaction(async (tx) => tx.reserveUsage(reservation(settledJob, 12_345)));
    await repository.transaction(async (tx) => tx.reserveUsage(reservation(releasedJob, 500)));
    await expect(
      repository.transaction(async (tx) => tx.reserveUsage(reservation(settledJob, 12_345)))
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    expect(await repository.transaction(async (tx) => tx.reservedMicroUsdForDay(owner, day))).toBe(12_845);

    await repository.transaction(async (tx) => tx.settleUsage(settledJob, 9_999, AT_LATER));
    const settled = await repository.transaction(async (tx) => tx.getReservation(settledJob));
    expect(settled).toMatchObject({ state: 'settled', settledMicroUsd: 9_999 });
    // Settled spend still counts toward the day: only the settled value replaces the
    // reserved estimate, so completing a job never frees budget for another one.
    expect(await repository.transaction(async (tx) => tx.reservedMicroUsdForDay(owner, day))).toBe(10_499);

    // Settlement is idempotent: the second call changes nothing.
    await repository.transaction(async (tx) => tx.settleUsage(settledJob, 111, AT_LATER));
    const settledAgain = await repository.transaction(async (tx) => tx.getReservation(settledJob));
    expect(settledAgain?.settledMicroUsd).toBe(9_999);

    // Release only affects reserved rows.
    await repository.transaction(async (tx) => tx.releaseUsage(settledJob, AT_LATER));
    const settledAfterRelease = await repository.transaction(async (tx) => tx.getReservation(settledJob));
    expect(settledAfterRelease?.state).toBe('settled');

    await repository.transaction(async (tx) => tx.releaseUsage(releasedJob, AT_LATER));
    const released = await repository.transaction(async (tx) => tx.getReservation(releasedJob));
    expect(released?.state).toBe('released');
    // Released spend stops counting; the settled 9_999 stays committed for the day.
    expect(await repository.transaction(async (tx) => tx.reservedMicroUsdForDay(owner, day))).toBe(9_999);

    await repository.transaction(async (tx) =>
      tx.appendUsageEvent({
        id: `evt_${uniqueSuffix()}`,
        tenantId: owner,
        jobId: settledJob,
        kind: 'settle',
        microUsd: 9_999,
        at: AT_LATER
      })
    );
  });

  it('serialises the daily budget check so only one admission fits the ceiling', async () => {
    const owner = tenant('budget');
    const day = '2026-10-02';
    const limit = 100;
    const admission = (jobId: string) =>
      repository.transaction(async (tx) => {
        // Mirrors admission: read the committed day total, then reserve.
        const committed = await tx.reservedMicroUsdForDay(owner, day);
        if (committed + 100 > limit) {
          throw new GatewayError('COST_LIMIT_EXCEEDED', 'Daily spend ceiling reached.', {
            details: { committed, limit }
          });
        }
        await tx.reserveUsage({
          jobId,
          tenantId: owner,
          day,
          microUsd: 100,
          providerAccountId: 'acct-1',
          state: 'reserved',
          createdAt: AT
        });
        return jobId;
      });

    // Deterministic interleaving: the first admission reads the total, then hands
    // control to the second while it still holds the day lock, so an unserialised
    // second read would observe 0 and overshoot the ceiling.
    const handoff = Promise.withResolvers<void>();
    const first = repository.transaction(async (tx) => {
      const committed = await tx.reservedMicroUsdForDay(owner, day);
      if (committed + 100 > limit) {
        throw new GatewayError('COST_LIMIT_EXCEEDED', 'Daily spend ceiling reached.', {
          details: { committed, limit }
        });
      }
      handoff.resolve();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await tx.reserveUsage({
        jobId: 'job_budget_a',
        tenantId: owner,
        day,
        microUsd: 100,
        providerAccountId: 'acct-1',
        state: 'reserved',
        createdAt: AT
      });
      return 'job_budget_a';
    });
    await handoff.promise;
    const second = admission('job_budget_b');

    const results = await Promise.allSettled([first, second]);
    const admitted = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toMatchObject({ code: 'COST_LIMIT_EXCEEDED' });
    expect(await repository.transaction(async (tx) => tx.reservedMicroUsdForDay(owner, day))).toBe(100);
  });

  it('consumes a confirmation exactly once under concurrency', async () => {
    const owner = tenant('confirmation');
    const tokenHash = `token_hash_${uniqueSuffix()}`;
    const record: ConfirmationRecord = {
      tokenHash,
      tenantId: owner,
      tool: 'higgsfield.generate_video',
      requestHash: 'request-hash',
      estimatedMicroUsd: 900_000,
      expiresAt: '2026-10-02T10:15:00.000Z',
      createdAt: AT
    };
    await repository.transaction(async (tx) => tx.putConfirmation(record));
    const stored = await repository.transaction(async (tx) => tx.getConfirmation(tokenHash));
    expect(stored).toEqual(record);

    const consume = () => repository.transaction(async (tx) => tx.consumeConfirmation(tokenHash, AT_LATER));
    const [first, second] = await Promise.all([consume(), consume()]);
    const winners = [first, second].filter((result) => result !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.consumedAt).toBe(AT_LATER);

    await expect(consume()).resolves.toBeUndefined();
    // A re-put must not resurrect a consumed token.
    await repository.transaction(async (tx) => tx.putConfirmation(record));
    const stillConsumed = await repository.transaction(async (tx) => tx.getConfirmation(tokenHash));
    expect(stillConsumed?.consumedAt).toBe(AT_LATER);
  });

  it('stores assets without a size when the provider does not report one', async () => {
    const owner = tenant('assets');
    const withoutSize = makeAsset(owner, 'asset_no_size');
    const withSize = makeAsset(owner, 'asset_with_size', { size: 2_048, width: 1024, height: 1024 });

    await repository.transaction(async (tx) => {
      await tx.insertAsset(withoutSize);
      await tx.insertAsset(withSize);
    });

    const storedWithoutSize = await repository.transaction(async (tx) => tx.getAsset(owner, withoutSize.id));
    expect(storedWithoutSize?.size).toBeUndefined();
    expect(storedWithoutSize).toEqual(withoutSize);

    const storedWithSize = await repository.transaction(async (tx) => tx.getAsset(owner, withSize.id));
    expect(storedWithSize?.size).toBe(2_048);
    expect(storedWithSize?.width).toBe(1024);

    await expect(repository.transaction(async (tx) => tx.insertAsset(withoutSize))).rejects.toMatchObject({
      code: 'INTERNAL_ERROR'
    });

    const updated = await repository.transaction(async (tx) =>
      tx.updateAsset(owner, withoutSize.id, { origin: 'managed', storageKey: 'assets/key.png' })
    );
    expect(updated).toMatchObject({ origin: 'managed', storageKey: 'assets/key.png' });
    expect(updated?.size).toBeUndefined();

    const pageOne = await repository.transaction(async (tx) => tx.listAssets(owner, { limit: 1 }));
    expect(pageOne.assets).toHaveLength(1);
    expect(pageOne.nextCursor).toBeDefined();
  });

  it('appends audit events with their details', async () => {
    const owner = tenant('audit');
    const id = `audit_${uniqueSuffix()}`;
    await repository.transaction(async (tx) =>
      tx.appendAuditEvent({
        id,
        tenantId: owner,
        at: AT,
        event: 'job.created',
        jobId: 'job_audit',
        requestId: 'req-1',
        details: { tool: 'higgsfield.generate_image' }
      })
    );

    const client = await rawClient(connectionString);
    try {
      const row = firstRow(await client.query('SELECT tenant_id, event, details FROM audit_events WHERE id = $1', [id]));
      expect(row['tenant_id']).toBe(owner);
      expect(row['event']).toBe('job.created');
      expect(row['details']).toEqual({ tool: 'higgsfield.generate_image' });
    } finally {
      await client.end();
    }
  });
});
