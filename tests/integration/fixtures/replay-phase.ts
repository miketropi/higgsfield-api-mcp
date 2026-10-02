import { writeSync } from 'node:fs';
import type { LoggerPort } from '@higgsfield-mcp/core';
import {
  canonicalJson,
  createPostgresJobRepository,
  createSubmissionWorker,
  newId,
  parseEncryptionKey,
  sha256Hex
} from '@higgsfield-mcp/core';
import { HIGGSFIELD_PROVIDER_ID, HiggsfieldProvider } from '@higgsfield-mcp/provider-higgsfield';
import type { JobRepository, MediaService, RequestContext } from '@higgsfield-mcp/core';

/**
 * Child-process phase for the restart-replay gate.
 *
 *   crash  — the gateway POSTs to the provider and dies before persisting the
 *            acknowledgement (the classic lost-acknowledgement window).
 *   resume — a fresh gateway process recovers the envelope and replays it.
 */

const mode = process.argv[2];
const databaseUrl = process.env['HF_REPLAY_DATABASE_URL'];
const providerUrl = process.env['HF_REPLAY_PROVIDER_URL'];
if (databaseUrl === undefined || providerUrl === undefined || mode === undefined) {
  process.stderr.write('missing replay phase configuration\n');
  process.exit(2);
}

const logger: LoggerPort = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  }
};

const repository: JobRepository = createPostgresJobRepository({
  connectionString: databaseUrl,
  logger,
  encryptionKey: parseEncryptionKey(Buffer.alloc(32, 5).toString('base64'))
});

const context: RequestContext = {
  requestId: 'req_replay',
  tenantId: 'tenant-replay',
  transport: 'stdio',
  auth: { tenantId: 'tenant-replay', mode: 'stdio' as const, scopes: ['higgsfield:generate'] }
};

const provider = new HiggsfieldProvider({
  credentials: { credentials: 'Key replay-id:replay-secret', accountId: 'acct-replay' },
  baseUrl: providerUrl,
  requestTimeoutMs: 5_000
});

/** The reliability gate never resolves media; a prompt-only request touches none of it. */
const unusedMedia: MediaService = {
  async upload() {
    throw new Error('media is not part of the replay gate');
  },
  async get() {
    throw new Error('media is not part of the replay gate');
  },
  async resolve() {
    throw new Error('media is not part of the replay gate');
  },
  async identify() {
    throw new Error('media is not part of the replay gate');
  }
};
void unusedMedia;

const jobId = process.env['HF_REPLAY_JOB_ID'];
const replayKey = process.env['HF_REPLAY_KEY'];
if (replayKey === undefined || replayKey.length === 0) {
  process.stderr.write('HF_REPLAY_KEY is required so both phases share one upstream key\n');
  process.exit(2);
}
const now = new Date().toISOString();
const plan = provider.prepare({
  endpoint: 'xai/grok-imagine-image-2.0',
  input: { prompt: 'replay gate image', aspect_ratio: '1:1' },
  upstreamIdempotencyKey: replayKey,
  jobKind: 'generation'
});

if (mode === 'crash') {
  const id = jobId ?? newId('job');
  await repository.transaction(async (tx) => {
    await tx.insertJob({
      id,
      tenantId: context.tenantId as string,
      provider: HIGGSFIELD_PROVIDER_ID,
      capability: 'image_generation',
      model: 'xai/grok-imagine-image-2.0',
      endpoint: 'xai/grok-imagine-image-2.0',
      kind: 'generation',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      inputSummary: { prompt: { length: 17 } },
      assets: [],
      submissionState: 'pending',
      tool: 'higgsfield.generate_image',
      concurrencyClass: 'image'
    });
    await tx.putSubmission({
      jobId: id,
      tenantId: context.tenantId as string,
      provider: HIGGSFIELD_PROVIDER_ID,
      providerAccountId: 'acct-replay',
      jobKind: 'generation',
      concurrencyClass: 'image',
      endpoint: plan.endpoint,
      upstreamIdempotencyKey: replayKey,
      body: plan.body,
      bodyHash: plan.bodyHash,
      state: 'pending',
      attempts: 0,
      version: 1,
      createdAt: now,
      updatedAt: now
    });
  });
  const snapshot = await provider.submit(plan, { upstreamIdempotencyKey: replayKey });
  if (snapshot.providerJobId.length === 0) process.exit(3);
  // Crash exactly here: the provider accepted the request, the gateway did not persist it.
  // writeSync keeps the marker intact across process.exit().
  writeSync(1, `crash:${id}:${snapshot.providerJobId}:${sha256Hex(canonicalJson(plan.body))}\n`);
  process.exit(1);
}

if (mode === 'resume') {
  if (jobId === undefined) {
    process.stderr.write('HF_REPLAY_JOB_ID is required for the resume phase\n');
    process.exit(2);
  }
  const worker = createSubmissionWorker({
    repository,
    providerFactory: {
      providerId: HIGGSFIELD_PROVIDER_ID,
      async forContext() {
        return provider;
      }
    },
    clock: { now: () => new Date() },
    logger,
    metrics: {
      toolCall() {},
      toolError() {},
      jobStarted() {},
      jobFinished() {},
      providerRequest() {},
      providerError() {},
      mediaUploadBytes() {},
      estimatedCostUsd() {},
      activeJobs() {},
      queuedJobs() {}
    },
    maxPerClass: { image: 4, video: 2, other: 1 },
    pollFloorMs: 1,
    pollCeilingMs: 1,
    replayMinMs: 1,
    replayMaxMs: 1,
    random: () => 0.5
  });
  let ticks = 0;
  let job = await repository.transaction((tx) => tx.getJob(context.tenantId as string, jobId));
  while (ticks < 25 && job !== undefined && job.status !== 'completed' && job.status !== 'failed') {
    await worker.runOnce();
    ticks += 1;
    job = await repository.transaction((tx) => tx.getJob(context.tenantId as string, jobId));
  }
  const envelope = await repository.transaction((tx) => tx.getSubmission(context.tenantId as string, jobId));
  writeSync(
    1,
    `${JSON.stringify({
      status: job?.status,
      assets: job?.assets.length ?? 0,
      providerJobId: envelope?.providerJobId,
      attempts: envelope?.attempts,
      submissionState: envelope?.state
    })}\n`
  );
  await repository.close();
  process.exit(0);
}

process.stderr.write(`unknown replay phase ${String(mode)}\n`);
process.exit(2);
