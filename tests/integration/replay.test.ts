import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable, startHttpDouble } from './harness/services.js';
import type { LocalHttpServer } from './harness/services.js';
import { startDisposablePostgres } from './harness/postgres.js';
import type { DisposablePostgres } from './harness/postgres.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxBin = `${repoRoot}node_modules/.bin/tsx`;
const fixture = `${repoRoot}tests/integration/fixtures/replay-phase.ts`;
const docker = dockerAvailable();

interface RecordedSubmit {
  idempotencyKey: string | undefined;
  body: string;
  query: string;
}

function startProviderDouble(): Promise<{
  server: LocalHttpServer;
  submits: RecordedSubmit[];
  uniqueRequestIds: Set<string>;
}> {
  const submits: RecordedSubmit[] = [];
  const uniqueRequestIds = new Set<string>();
  const idByKey = new Map<string, string>();

  return startHttpDouble((request) => {
    const url = new URL(request.url, 'http://provider.test');
    if (request.method === 'POST' && url.pathname.startsWith('/estimate/')) {
      return { status: 200, body: { credits: '0.09', usd: '0.094' } };
    }
    if (request.method === 'POST' && url.pathname.startsWith('/requests/') && url.pathname.endsWith('/cancel')) {
      return { status: 202, body: {} };
    }
    if (request.method === 'GET' && url.pathname.startsWith('/requests/')) {
      const requestId = url.pathname.split('/')[2] ?? 'missing';
      return {
        status: 200,
        body: {
          status: 'completed',
          request_id: requestId,
          images: [{ url: `https://cdn.example.com/${requestId}.png` }]
        }
      };
    }
    if (request.method === 'POST') {
      const key = request.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(key) ? key[0] : key;
      submits.push({ idempotencyKey, body: request.body.toString('utf8'), query: url.search });
      let requestId = idempotencyKey === undefined ? undefined : idByKey.get(idempotencyKey);
      if (requestId === undefined) {
        requestId = `req-${uniqueRequestIds.size + 1}`;
        if (idempotencyKey !== undefined) idByKey.set(idempotencyKey, requestId);
      }
      uniqueRequestIds.add(requestId);
      return {
        status: 200,
        body: {
          status: 'queued',
          request_id: requestId,
          status_url: `http://provider.test/requests/${requestId}/status`,
          cancel_url: `http://provider.test/requests/${requestId}/cancel`
        }
      };
    }
    return { status: 404, body: { detail: 'not found' } };
  }).then((server) => ({ server, submits, uniqueRequestIds }));
}

/**
 * Runs one gateway phase in a real child process. Asynchronous on purpose: the
 * in-process provider double must stay responsive while the child runs.
 */
async function runPhase(
  phase: 'crash' | 'resume',
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; status: number }> {
  const child = spawn(tsxBin, [fixture, phase], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const { promise, resolve } = Promise.withResolvers<number>();
  child.on('close', (code) => resolve(code ?? 1));
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
  const status = await promise;
  clearTimeout(timeout);
  return {
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8').slice(-1_500),
    status
  };
}

describe.skipIf(!docker.available)('restart and replay gate', () => {
  let postgres: DisposablePostgres;
  let provider: Awaited<ReturnType<typeof startProviderDouble>>;

  beforeAll(async () => {
    postgres = await startDisposablePostgres();
    provider = await startProviderDouble();
    execFileSync(tsxBin, [`${repoRoot}tests/integration/fixtures/migrate.ts`], {
      cwd: repoRoot,
      env: { ...process.env, HF_MCP_DATABASE_URL: postgres.url },
      encoding: 'utf8',
      timeout: 120_000
    });
  });

  afterAll(async () => {
    await provider.server.close();
    if (postgres !== undefined) await postgres.stop();
  });

  it('replays the identical key and body after a crash between acceptance and persistence', async () => {
    const replayKey = '11111111-2222-3333-4444-555555555555';
    const jobId = 'job_replay_gate';
    const env = {
      HF_REPLAY_DATABASE_URL: postgres.url,
      HF_REPLAY_PROVIDER_URL: provider.server.url,
      HF_REPLAY_KEY: replayKey,
      HF_REPLAY_JOB_ID: jobId
    };

    const crash = await runPhase('crash', env);
    expect(crash.stdout, `phase stderr: ${crash.stderr}`).toContain(`crash:${jobId}:`);
    expect(provider.submits).toHaveLength(1);

    const resume = await runPhase('resume', env);
    expect(resume.stderr, `phase stderr: ${resume.stderr}`).toBe('');
    expect(resume.status).toBe(0);
    const outcome = JSON.parse(resume.stdout.trim()) as {
      status: string;
      assets: number;
      providerJobId: string;
      attempts: number;
      submissionState: string;
    };
    expect(outcome.status).toBe('completed');
    expect(outcome.assets).toBe(1);
    expect(outcome.submissionState).toBe('acknowledged');
    expect(outcome.providerJobId).toMatch(/^generation:req-1$/);

    // Two POSTs, one key, one body, one provider-side request id: the provider charged once.
    expect(provider.submits).toHaveLength(2);
    expect(provider.submits[0]?.idempotencyKey).toBe(replayKey);
    expect(provider.submits[1]?.idempotencyKey).toBe(replayKey);
    expect(provider.submits[0]?.body).toBe(provider.submits[1]?.body);
    expect(provider.uniqueRequestIds.size).toBe(1);
  });
});

describe.skipIf(docker.available)('restart and replay gate (docker required)', () => {
  it.skip('requires a Docker daemon to run the persistence gate', () => {});
});
