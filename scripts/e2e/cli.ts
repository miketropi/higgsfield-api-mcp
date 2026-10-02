/**
 * End-to-end verification harness for the Higgsfield MCP gateway.
 *
 *   pnpm test:e2e -- --profile distribution   (default)
 *   pnpm test:e2e -- --profile live           (paid; requires HF_MCP_LIVE_E2E=1)
 *
 * `distribution` proves the shipped artifacts: it builds the workspace, packs the npm
 * tarball, installs it into a disposable directory, drives the installed binary over
 * stdio with the real MCP client, then builds and runs the container image read-only
 * and non-root against the compose dependencies and a local fixture provider.
 *
 * The container runs in the default `passthrough` asset mode, so the asset read exercises
 * `higgsfield.media.get` against a provider URL. Managed (S3) assets are covered by the
 * compose stack's `HF_MCP_ASSET_MODE=managed` service and by the integration tests, not here.
 *
 * `live` is the only profile that may spend money. It refuses to run without
 * `HF_MCP_LIVE_E2E=1`, `HF_API_CREDENTIALS` and `HF_MCP_LIVE_MAX_USD`, prices every paid
 * call through the gateway's own confirmation flow, and aborts when the next estimate
 * would exceed the remaining budget.
 *
 * Environment knobs for the harness itself:
 *   HF_MCP_E2E_SKIP_DOCKER=1   record the container gate as skipped instead of failed
 *   HF_MCP_E2E_PORT=3199       host port the gateway container is published on
 *   HF_MCP_E2E_BIN=<path>      CLI to drive in the live profile (defaults to dist/cli.js)
 *   HF_MCP_LIVE_SOUL=1         enable the Soul ID training call in the live profile
 *   HF_MCP_LIVE_SOUL_IMAGE_URL public image URL used as the Soul ID reference
 *
 * The distribution profile's stdio discovery scenario never reaches the public
 * documentation site: the harness writes an official-page fixture directory into its
 * work directory and serves it to the installed CLI through `scripts/e2e/docs-fixture-preload.mjs`
 * (`HF_MCP_E2E_DOCS_FIXTURE`, injected via `NODE_OPTIONS=--import`). Nothing in the shipped
 * package is configurable for that host.
 *
 * Dependencies: Node standard library plus the repo's `tsx` and the MCP client SDK
 * (`@modelcontextprotocol/client`, a root devDependency). No new packages.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ModelDefinition } from '@higgsfield-mcp/core';
import { docsFixturePages } from '../../tests/fixtures/docs-directory.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const artifactsDir = join(repoRoot, 'artifacts');
const imageTag = 'higgsfield-mcp:verify';
const containerName = 'higgsfield-mcp-e2e';
const configuredPort = Number.parseInt(process.env['HF_MCP_E2E_PORT'] ?? '', 10);
const gatewayPort = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65_536 ? configuredPort : 3199;
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
/** The tenant audience must be an absolute https URL (config tenant schema), so the
 *  public URL advertised to tenants uses https while the harness talks plain http. */
const publicUrl = `https://127.0.0.1:${gatewayPort}`;

type Profile = 'distribution' | 'live';

interface StepResult {
  name: string;
  ok: boolean;
  command: string;
  detail: string;
}

const results: StepResult[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/* ------------------------------------------------------------------ process */

interface RunOptions {
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  input?: string | undefined;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((value) => (/^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`))
    .join(' ');
}

function run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 600_000,
    maxBuffer: 64 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input })
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

function must(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const detail = (result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim()).slice(0, 800);
    throw new Error(`${formatCommand(command, args)} exited ${String(result.status)}: ${detail}`);
  }
  return result;
}

/** Runs one reported step. The printed line carries the exact command and the result. */
async function step(name: string, command: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, ok: true, command, detail });
    log(`ok   ${name}\n     $ ${command}\n     -> ${detail.split('\n').join('\n     -> ')}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, command, detail });
    log(`FAIL ${name}\n     $ ${command}\n     -> ${detail.split('\n').join('\n     -> ')}`);
  }
}

function skip(name: string, command: string, detail: string): void {
  results.push({ name, ok: true, command, detail: `skipped: ${detail}` });
  log(`SKIP ${name}\n     $ ${command}\n     -> ${detail}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForHttp(url: string, timeoutMs: number, expect = 200): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === expect) return response.status;
      last = `status ${String(response.status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 750);
    await tick.promise;
  }
  throw new Error(`${url} did not answer ${String(expect)} within ${String(timeoutMs)}ms (${last})`);
}

/** Readiness wait that reports the container's own log tail when it times out. */
async function waitForContainerHttp(url: string, timeoutMs: number, container: string): Promise<void> {
  try {
    await waitForHttp(url, timeoutMs);
  } catch (error) {
    const logs = run('docker', ['logs', '--tail', '80', container], { timeoutMs: 60_000 });
    const tail = `${logs.stdout}${logs.stderr}`.trim().split('\n').slice(-25).join('\n');
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n     container logs:\n     ${tail.split('\n').join('\n     ')}`
    );
  }
}

/** Binds an ephemeral port and releases it, so compose publishes on a free host port. */
async function freeHostPort(taken: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = createServer();
    const bound = Promise.withResolvers<number>();
    probe.on('error', () => bound.resolve(0));
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      bound.resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
    const port = await bound.promise;
    const closed = Promise.withResolvers<void>();
    probe.close(() => closed.resolve());
    await closed.promise;
    if (port > 0 && !taken.has(port)) {
      taken.add(port);
      return port;
    }
  }
  throw new Error('could not find a free host port for the compose dependencies');
}

/* ------------------------------------------------------------------ fixtures */

interface FixtureProvider {
  url: string;
  internalUrl: string;
  submissions: { idempotencyKey: string | undefined; body: string }[];
  polls: () => number;
  release: () => void;
  close: () => Promise<void>;
}

/**
 * Minimal stand-in for the documented Higgsfield API surfaces the adapter uses:
 * `POST /{endpoint_id}` (submit), `GET /requests/{id}/status`, `POST /requests/{id}/cancel`,
 * `POST /estimate/{endpoint_id}` and `POST /files/generate-upload-url`.
 *
 * The status path reports `in_progress` until `release()` is called, which is what makes
 * the restart-continuity step deterministic: the job must still be in flight when the
 * container receives SIGTERM.
 */
async function startFixtureProvider(): Promise<FixtureProvider> {
  const submissions: FixtureProvider['submissions'] = [];
  const byIdempotencyKey = new Map<string, string>();
  let released = false;
  let pollCount = 0;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid');
      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };

      if (request.method === 'POST' && url.pathname === '/_control/release') {
        released = true;
        return send(200, { released: true });
      }
      if (request.method === 'POST' && url.pathname.startsWith('/estimate/')) {
        return send(200, { credits: '0.090', usd: '0.094' });
      }
      if (request.method === 'POST' && url.pathname === '/files/generate-upload-url') {
        return send(200, {
          public_url: 'https://cdn.example.com/input/upload.png',
          upload_url: 'https://cdn.example.com/presigned-upload',
          content_type: 'image/png',
          upload_headers: { 'Content-Type': 'image/png' }
        });
      }
      if (request.method === 'POST' && /^\/requests\/[^/]+\/cancel$/.test(url.pathname)) {
        return send(202, {});
      }
      if (request.method === 'GET' && /^\/requests\/[^/]+\/status$/.test(url.pathname)) {
        pollCount += 1;
        const requestId = url.pathname.split('/')[2] ?? 'unknown';
        if (!released) return send(200, { status: 'in_progress', request_id: requestId });
        return send(200, {
          status: 'completed',
          request_id: requestId,
          images: [{ url: 'https://cdn.example.com/fixture-output.png' }]
        });
      }
      if (request.method === 'POST') {
        const header = request.headers['idempotency-key'];
        const idempotencyKey = Array.isArray(header) ? header[0] : header;
        const body = Buffer.concat(chunks).toString('utf8');
        submissions.push({ idempotencyKey, body });
        let requestId = idempotencyKey === undefined ? undefined : byIdempotencyKey.get(idempotencyKey);
        if (requestId === undefined) {
          requestId = `req-${String(byIdempotencyKey.size + 1)}`;
          if (idempotencyKey !== undefined) byIdempotencyKey.set(idempotencyKey, requestId);
        }
        return send(200, { status: 'queued', request_id: requestId });
      }
      send(404, { detail: 'not found' });
    });
  });

  const bound = Promise.withResolvers<number>();
  server.listen(0, '0.0.0.0', () => {
    const address = server.address();
    bound.resolve(typeof address === 'object' && address !== null ? address.port : 0);
  });
  const listening = await bound.promise;

  return {
    url: `http://127.0.0.1:${String(listening)}`,
    internalUrl: `http://host.docker.internal:${String(listening)}`,
    submissions,
    polls: () => pollCount,
    release: () => {
      released = true;
    },
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  };
}

/* ------------------------------------------------------------------- docker */

function docker(args: readonly string[], options: RunOptions = {}): RunResult {
  return run('docker', args, options);
}

function dockerAvailable(): boolean {
  return docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30_000 }).status === 0;
}

/** First `KEY=value` entry whose key matches, or undefined. */
function envValue(entries: readonly string[], key: string): string | undefined {
  const prefix = `${key}=`;
  const found = entries.find((entry) => entry.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

interface ComposeDependencies {
  network: string;
  objectStoreService: string;
  databaseUrl: string;
  redisUrl: string;
}

/**
 * Starts the compose integration dependencies and discovers everything the gateway
 * container needs from the running containers themselves, so the harness never guesses
 * the compose file's service names, database name, credentials or published ports.
 *
 * `composeEnv` supplies every value the compose file requires, so the gate runs whether
 * or not a local `.env` exists; these are throwaway integration values, never secrets.
 */
async function startComposeDependencies(
  composeFile: string,
  composeEnv: Record<string, string>
): Promise<ComposeDependencies> {
  const services = must('docker', ['compose', '-f', composeFile, 'config', '--services'], { env: composeEnv })
    .stdout.trim()
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  for (const required of ['postgres', 'redis']) {
    assert(services.includes(required), `docker-compose.yml has no "${required}" service (services: ${services.join(', ')})`);
  }
  // The object store is the "minio role" service; this stack may name it anything.
  const objectStoreService =
    ['minio', 'objectstore', 'seaweedfs', 's3'].find((name) => services.includes(name)) ??
    services.find((name) => /minio|seaweed|object/i.test(name));
  assert(
    objectStoreService !== undefined,
    `docker-compose.yml has no object store service (services: ${services.join(', ')})`
  );

  must('docker', ['compose', '-f', composeFile, 'up', '-d', '--wait', 'postgres', 'redis', objectStoreService], {
    env: composeEnv,
    timeoutMs: 900_000
  });

  const containerEnv = (service: string): string[] => {
    const id = must('docker', ['compose', '-f', composeFile, 'ps', '-q', service], { env: composeEnv }).stdout.trim();
    assert(id !== '', `compose did not report a ${service} container id`);
    const parsed = JSON.parse(must('docker', ['inspect', id]).stdout) as { Config?: { Env?: string[] } }[];
    const first = parsed[0];
    assert(first !== undefined, `docker inspect returned no ${service} container`);
    return first.Config?.Env ?? [];
  };

  const postgresEnv = containerEnv('postgres');
  const postgresId = must('docker', ['compose', '-f', composeFile, 'ps', '-q', 'postgres'], { env: composeEnv }).stdout.trim();
  const postgresInspect = JSON.parse(must('docker', ['inspect', postgresId]).stdout) as {
    NetworkSettings?: { Networks?: Record<string, unknown> };
  }[];
  const network = Object.keys(postgresInspect[0]?.NetworkSettings?.Networks ?? {})[0];
  // `bridge` means docker attached the container to the default bridge instead of the
  // compose project network, which cannot resolve service names; fail loudly rather than
  // letting every dependent step run with an unreachable database.
  assert(
    network !== undefined && network !== 'bridge',
    `could not resolve the compose project network for postgres (found "${String(network)}")`
  );

  const user = encodeURIComponent(envValue(postgresEnv, 'POSTGRES_USER') ?? 'postgres');
  const password = encodeURIComponent(envValue(postgresEnv, 'POSTGRES_PASSWORD') ?? 'postgres');
  const database = envValue(postgresEnv, 'POSTGRES_DB') ?? 'postgres';

  const redisPassword = envValue(containerEnv('redis'), 'REDIS_PASSWORD');
  const redisCredentials = redisPassword === undefined ? '' : `:${encodeURIComponent(redisPassword)}@`;

  return {
    network,
    objectStoreService,
    databaseUrl: `postgres://${user}:${password}@postgres:5432/${database}`,
    redisUrl: `redis://${redisCredentials}redis:6379`
  };
}

/* --------------------------------------------------------------------- mcp */

type JsonObject = Record<string, unknown>;

function structured(result: unknown): JsonObject {
  const value = (result as { structuredContent?: unknown }).structuredContent;
  if (value === null || typeof value !== 'object') throw new Error('the tool returned no structured content');
  return value as JsonObject;
}

function toolError(result: unknown): string | undefined {
  const object = result as { isError?: unknown; content?: { type?: unknown; text?: unknown }[] };
  if (object.isError !== true) return undefined;
  const text = object.content?.[0]?.text;
  return typeof text === 'string' ? text : 'the tool reported an error with no text content';
}

async function connectStdio(command: string, args: readonly string[], env: Record<string, string>): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command,
    args: [...args],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: 'pipe'
  });
  // Buffered so a child that dies during the handshake reports why, not just "closed".
  const diagnostics: Buffer[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => diagnostics.push(chunk));
  const client = new Client({ name: 'higgsfield-e2e', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(transport);
  } catch (error) {
    const detail = Buffer.concat(diagnostics).toString('utf8').trim().slice(0, 1_500);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${detail === '' ? '' : `\nchild stderr:\n${detail}`}`
    );
  }
  return { client, transport };
}

async function connectHttp(url: string, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(token === undefined ? {} : { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  });
  const client = new Client({ name: 'higgsfield-e2e', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return client;
}

/* ------------------------------------------------------------ distribution */

interface StdioProtocolProbe {
  stdoutLines: string[];
  stderr: string;
  toolCount: number;
}

/**
 * Speaks raw newline-delimited JSON-RPC to the CLI over pipes — no client SDK in the
 * path — so every byte the server writes to stdout can be inspected. Sends `initialize`,
 * then `notifications/initialized` and a real `tools/list` call, and returns the raw
 * frames, the child's stderr, and the tool count from that call.
 */
async function probeStdioProtocol(command: string, args: readonly string[], env: Record<string, string>): Promise<StdioProtocolProbe> {
  const child = spawn(command, [...args], {
    env: { ...(process.env as Record<string, string>), ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const exited = Promise.withResolvers<void>();
  child.on('exit', () => exited.resolve());

  const stdoutLines: string[] = [];
  const stderrChunks: string[] = [];
  const toolsListed = Promise.withResolvers<number>();
  let pending = '';
  let handshakeSent = false;

  const handleLine = (line: string): void => {
    if (line.trim() === '') return;
    stdoutLines.push(line);
    let frame: { id?: unknown; result?: { tools?: unknown } };
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      return;
    }
    if (frame.id === 1 && !handshakeSent) {
      handshakeSent = true;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
      return;
    }
    if (frame.id === 2) {
      toolsListed.resolve(Array.isArray(frame.result?.tools) ? (frame.result.tools as unknown[]).length : -1);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    let index = pending.indexOf('\n');
    while (index !== -1) {
      handleLine(pending.slice(0, index));
      pending = pending.slice(index + 1);
      index = pending.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'higgsfield-e2e', version: '1.0.0' } }
    })}\n`
  );

  const timedOut = Promise.withResolvers<void>();
  const timer = setTimeout(timedOut.resolve, 30_000);
  const toolCount = await Promise.race([toolsListed.promise, timedOut.promise.then(() => -1)]);
  clearTimeout(timer);
  child.kill('SIGTERM');
  await exited.promise;

  return { stdoutLines, stderr: stderrChunks.join(''), toolCount };
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (statSync(current).isDirectory()) {
      for (const entry of readdirSync(current)) stack.push(join(current, entry));
    } else {
      out.push(current);
    }
  }
  return out;
}

const SPECIFIER_PATTERNS: readonly RegExp[] = [
  // Static imports and re-exports, anchored to statement context: prose that merely
  // contains the word "from" inside a string or template literal is not a module.
  /(?:^|;)\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"\n]+)['"]/gm,
  /(?:^|;)\s*import\s*['"]([^'"\n]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g
];

/** Anything with whitespace or interpolation is prose, not a module specifier. */
const NOT_A_SPECIFIER = /[\s${}`'"]/;

function collectBareSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      const specifier = match[1];
      if (
        specifier !== undefined &&
        !specifier.startsWith('.') &&
        !specifier.startsWith('/') &&
        !specifier.startsWith('#') &&
        !specifier.includes('://') &&
        !specifier.startsWith('node:') &&
        !NOT_A_SPECIFIER.test(specifier)
      ) {
        found.push(specifier);
      }
      match = pattern.exec(source);
    }
  }
  return found;
}

/**
 * Proves the packed package is self-contained: no `workspace:` specifier anywhere in the
 * tarball, and every bare import in the shipped JavaScript resolves inside the install
 * directory (never back into the monorepo).
 */
function assertPackedTreeIsSelfContained(workDir: string): string {
  const packageDir = join(workDir, 'node_modules', 'higgsfield-mcp');
  const files = walkFiles(packageDir);
  assert(files.length > 0, 'the installed package has no files');

  for (const file of files) {
    if (!/\.(?:js|mjs|cjs|json)$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    assert(!source.includes('workspace:'), `${file.replace(workDir, '<tmp>')} still references a workspace: specifier`);
  }

  const specifiers = new Set<string>();
  for (const file of files) {
    if (!/\.(?:js|mjs|cjs)$/.test(file)) continue;
    for (const specifier of collectBareSpecifiers(readFileSync(file, 'utf8'))) specifiers.add(specifier);
  }
  assert(specifiers.size > 0, 'no import specifiers were found in the packed output; the assertion would be vacuous');

  const resolver = join(workDir, 'resolve-specifiers.mjs');
  writeFileSync(
    resolver,
    `const specifiers = JSON.parse(process.argv[2]);
const out = [];
for (const specifier of specifiers) {
  try { out.push([specifier, import.meta.resolve(specifier)]); }
  catch (error) { out.push([specifier, 'ERROR: ' + (error instanceof Error ? error.message : String(error))]); }
}
process.stdout.write(JSON.stringify(out));
`,
    'utf8'
  );
  const resolved = must(process.execPath, [resolver, JSON.stringify([...specifiers])], { cwd: workDir, timeoutMs: 60_000 });
  const pairs = JSON.parse(resolved.stdout) as [string, string][];
  // `import.meta.resolve` reports real paths, and `os.tmpdir()` is a symlink on macOS,
  // so both the literal and the canonical form of the install directory are accepted.
  const nodeModulesPrefixes = [workDir, realpathSync(workDir)].map((dir) =>
    pathToFileURL(join(dir, 'node_modules')).href.replace(/\/?$/, '/')
  );
  const outside: string[] = [];
  for (const [specifier, target] of pairs) {
    if (nodeModulesPrefixes.some((prefix) => target.startsWith(prefix))) continue;
    if (target.startsWith('node:')) continue;
    outside.push(`${specifier} -> ${target}`);
  }
  assert(outside.length === 0, `imports resolve outside the installed package:\n${outside.join('\n')}`);
  return `${specifiers.size} import specifier(s) all resolve inside the installed package`;
}

async function distributionProfile(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'hf-e2e-'));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
  mkdirSync(artifactsDir, { recursive: true });
  const fixture = await startFixtureProvider();
  cleanups.push(() => fixture.close());

  let tarball = '';

  await step(
    'build workspace packages and the gateway CLI',
    'pnpm -r --filter "./packages/**" run build && pnpm --filter higgsfield-mcp run build',
    () => {
      must('pnpm', ['-r', '--filter', './packages/**', 'run', 'build'], { timeoutMs: 1_800_000 });
      must('pnpm', ['--filter', 'higgsfield-mcp', 'run', 'build'], { timeoutMs: 1_800_000 });
      const cli = join(repoRoot, 'apps/server/dist/cli.js');
      assert(existsSync(cli), 'apps/server/dist/cli.js was not produced by the build');
      return 'apps/server/dist/cli.js present';
    }
  );

  await step('pack the npm tarball', `pnpm --filter higgsfield-mcp pack --pack-destination ${artifactsDir}`, () => {
    const output = must('pnpm', ['--filter', 'higgsfield-mcp', 'pack', '--pack-destination', artifactsDir], {
      timeoutMs: 600_000
    }).stdout;
    const match = /([^\s]+\.tgz)/.exec(output);
    assert(match?.[1] !== undefined, `pnpm pack printed no tarball path: ${output.trim().slice(0, 300)}`);
    const reported = match[1];
    tarball = reported.startsWith('/') ? reported : join(artifactsDir, reported.split('/').pop() ?? '');
    assert(existsSync(tarball), `expected a tarball at ${tarball}`);
    return tarball.replace(`${repoRoot}/`, '');
  });

  const npmCache = join(workDir, 'npm-cache');
  const installArgs = [
    'install',
    tarball,
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--no-package-lock',
    '--cache',
    npmCache
  ];

  await step('install the tarball into a clean directory', `npm ${installArgs.join(' ')}  (cwd ${workDir})`, () => {
    must('npm', ['init', '-y'], { cwd: workDir, timeoutMs: 120_000 });
    must('npm', installArgs, { cwd: workDir, timeoutMs: 900_000 });
    const manifest = JSON.parse(readFileSync(join(workDir, 'node_modules/higgsfield-mcp/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      bin?: Record<string, string>;
    };
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      assert(!spec.includes('workspace:'), `${name} still resolves ${spec} in the packed manifest`);
    }
    assert(manifest.bin?.['higgsfield-mcp'] !== undefined, 'the packed package exposes no higgsfield-mcp bin');
    return `${Object.keys(manifest.dependencies ?? {}).length} dependencies, no workspace:* specifiers`;
  });

  await step('assert the packed tree resolves nothing outside itself', 'node resolve-specifiers.mjs', () =>
    assertPackedTreeIsSelfContained(workDir)
  );

  const binary = join(workDir, 'node_modules/.bin/higgsfield-mcp');
  const allowedPaths = join(workDir, 'media');
  mkdirSync(allowedPaths, { recursive: true });
  const installedEnv: Record<string, string> = {
    HF_API_CREDENTIALS: 'Key e2e-id:e2e-secret',
    HF_MCP_ALLOWED_PATHS: allowedPaths,
    HF_MCP_PROVIDER_BASE_URL: fixture.url,
    HF_MCP_LOG_LEVEL: 'error'
  };

  await step('run version and doctor from the installed package', `${binary} version && ${binary} doctor`, () => {
    const version = JSON.parse(must(binary, ['version'], { cwd: workDir, env: installedEnv }).stdout) as {
      version?: string;
      mcp_protocol?: string;
    };
    assert(typeof version.version === 'string' && version.version.length > 0, 'version output carried no version');
    const doctor = run(binary, ['doctor'], { cwd: workDir, env: installedEnv });
    assert(
      doctor.stdout.includes('doctor: all checks passed'),
      `doctor did not pass (exit ${String(doctor.status)}): ${doctor.stdout.trim().split('\n').slice(-3).join(' | ')}`
    );
    return `version ${version.version}, protocol ${String(version.mcp_protocol)}, doctor clean`;
  });

  // Model discovery reads the provider's public documentation directory. CI has no
  // internet, so the harness injects an official-page fixture for that one host through a
  // preload module (see docs-fixture-preload.mjs) and drives the installed binary the
  // same way it always did. The shipped package keeps its fixed documentation origin.
  // The fixture documents the *bundled* manifest's schemas, so the installed binary sees
  // the same execution-support verdicts it would compute against the real site.
  const bundledRegistry = JSON.parse(
    readFileSync(join(repoRoot, 'packages', 'provider-higgsfield', 'src', 'models', 'registry.json'), 'utf8')
  ) as { models: ModelDefinition[] };
  const docsFixturePath = join(workDir, 'docs-fixture.json');
  writeFileSync(docsFixturePath, JSON.stringify(docsFixturePages({ manifest: bundledRegistry.models })), 'utf8');
  const preload = pathToFileURL(join(repoRoot, 'scripts', 'e2e', 'docs-fixture-preload.mjs')).href;
  const docsEnv: Record<string, string> = {
    ...installedEnv,
    HF_MCP_E2E_DOCS_FIXTURE: docsFixturePath,
    NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --import ${preload}`.trim()
  };

  await step('drive stdio discovery with the real MCP client', `${binary} serve --transport stdio`, async () => {
    const { client } = await connectStdio(binary, ['serve', '--transport', 'stdio'], docsEnv);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      assert(names.length === 14, `expected 14 tools over stdio, saw ${String(names.length)}: ${names.join(', ')}`);
      assert(names.includes('higgsfield.generate_image'), 'higgsfield.generate_image is missing from tools/list');

      const models = structured(await client.callTool({ name: 'higgsfield.models.list', arguments: {} }));
      const modelList = models['models'];
      assert(Array.isArray(modelList) && modelList.length > 0, 'higgsfield.models.list returned no models');
      const catalog = models['catalog'] as Record<string, unknown> | undefined;
      assert(catalog?.['source'] === 'official_documentation', 'models.list did not report documentation provenance');
      assert(
        catalog['source_url'] === 'https://docs.higgsfield.ai/docs/models.md',
        `unexpected catalog source URL ${String(catalog['source_url'])}`
      );
      assert(catalog['stale'] === false, 'the first discovery snapshot must not be stale');
      const entries = modelList as { id: string; execution: { supported: boolean } }[];
      const supported = entries.filter((model) => model.execution.supported);
      assert(supported.length > 0, 'no discovered model reports execution support');
      const documentedOnly = entries.find((model) => model.id === 'alibaba/qwen-image-3/text-to-image');
      assert(documentedOnly !== undefined, 'a documented-only workflow is missing from models.list');
      assert(documentedOnly.execution.supported === false, 'a documented-only workflow claimed execution support');

      const detail = structured(
        await client.callTool({ name: 'higgsfield.models.get', arguments: { model: 'xai/grok-imagine-image-2.0' } })
      );
      assert(detail['execution'] !== undefined, 'models.get returned no execution verdict');

      const capabilities = structured(await client.callTool({ name: 'higgsfield.capabilities', arguments: {} }));
      assert(capabilities['mcp_protocol'] === '2026-07-28', `unexpected MCP revision ${String(capabilities['mcp_protocol'])}`);
      const toolsBlock = capabilities['tools'] as { count: number; names: string[] } | undefined;
      assert(toolsBlock?.count === names.length, 'capabilities.tools.count does not match tools/list');
      assert(
        [...(toolsBlock?.names ?? [])].sort().join(',') === [...names].sort().join(','),
        'capabilities.tools.names does not match tools/list'
      );

      const resources = await client.listResources();
      const uris = resources.resources.map((resource) => resource.uri);
      for (const required of ['higgsfield://models', 'higgsfield://capabilities']) {
        assert(uris.includes(required), `resource ${required} is not registered`);
      }

      return (
        `${String(names.length)} tools, ${String(modelList.length)} documented models` +
        ` (${String(supported.length)} executable), protocol 2026-07-28, ${String(uris.length)} resources`
      );
    } finally {
      await client.close();
    }
  });

  await step(
    'keep stdout free of log lines in stdio mode',
    `${binary} serve --transport stdio  (raw JSON-RPC probe)`,
    async () => {
      const probe = await probeStdioProtocol(binary, ['serve', '--transport', 'stdio'], {
        ...installedEnv,
        HF_MCP_LOG_LEVEL: 'debug'
      });
      assert(probe.stdoutLines.length >= 2, `the probe saw only ${String(probe.stdoutLines.length)} stdout frame(s)`);
      for (const line of probe.stdoutLines) {
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          throw new Error(`stdout carried a non-JSON line: ${line.slice(0, 200)}`);
        }
        assert(
          (frame as { jsonrpc?: unknown }).jsonrpc === '2.0',
          `stdout carried a JSON value that is not a JSON-RPC frame: ${line.slice(0, 200)}`
        );
      }
      assert(
        !probe.stdoutLines.some((line) => /"level":\s*\d/.test(line)),
        'a log record was written to stdout during the probe'
      );
      assert(probe.toolCount === 14, `the tools/list probe saw ${String(probe.toolCount)} tools`);
      assert(
        /"event":"/.test(probe.stderr),
        'the process logged nothing structured to stderr, so the probe proved nothing'
      );
      return `${String(probe.stdoutLines.length)} stdout frame(s) all JSON-RPC 2.0, 14 tools listed, ${String(
        probe.stderr.trim().split('\n').length
      )} log line(s) on stderr`;
    }
  );

  /* --------------------------------------------------------------- container */

  const composeFile = join(repoRoot, 'docker-compose.yml');
  const dockerfile = join(repoRoot, 'Dockerfile');
  const hasDocker = dockerAvailable();

  if (!hasDocker) {
    const detail = 'docker daemon unavailable; the container gate did not run';
    if (process.env['HF_MCP_E2E_SKIP_DOCKER'] === '1') {
      skip('container gate', 'docker build . && docker compose up -d --wait postgres redis <object store service>', detail);
      return;
    }
    results.push({ name: 'container gate', ok: false, command: 'docker build .', detail: `${detail} (set HF_MCP_E2E_SKIP_DOCKER=1 to record it as skipped instead)` });
    log(`FAIL container gate\n     -> ${detail}`);
    return;
  }

  await step('build the container image and assert it is non-root', 'docker build -t higgsfield-mcp:verify .', () => {
    assert(existsSync(dockerfile), 'Dockerfile is missing');
    must('docker', ['build', '-t', imageTag, '.'], { timeoutMs: 1_800_000 });
    const user = must('docker', ['image', 'inspect', imageTag, '--format', '{{.Config.User}}']).stdout.trim();
    assert(!['', 'root', '0', '0:0'].includes(user), `the image does not set a non-root user (User="${user}")`);
    return `image built, runtime user ${user}`;
  });

  // Every value the compose file marks as required, generated per run. Compose
  // interpolates the whole file before selecting services, so all of them must be
  // resolvable even though only the three infrastructure services are started here.
  // These are throwaway integration values, never real credentials. The published host
  // ports are taken from the OS so a locally running PostgreSQL/Redis cannot collide
  // with the stack (the containers talk to each other by service name, not via these).
  const claimedPorts = new Set<number>();
  const composeEnv: Record<string, string> = {
    POSTGRES_PASSWORD: randomBytes(16).toString('hex'),
    REDIS_PASSWORD: randomBytes(16).toString('hex'),
    HF_MCP_S3_ACCESS_KEY_ID: `e2e${randomBytes(6).toString('hex')}`,
    HF_MCP_S3_SECRET_ACCESS_KEY: randomBytes(24).toString('hex'),
    HF_MCP_DEV_TOKEN: `hf_e2e_${randomBytes(24).toString('hex')}`,
    HF_MCP_PROVIDER_ACCOUNT_ID: 'acct-e2e',
    HF_MCP_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    HF_MCP_METRICS_TOKEN: randomBytes(16).toString('hex'),
    HF_API_CREDENTIALS: 'Key e2e-id:e2e-secret',
    POSTGRES_PORT: String(await freeHostPort(claimedPorts)),
    REDIS_PORT: String(await freeHostPort(claimedPorts)),
    HF_MCP_S3_PORT: String(await freeHostPort(claimedPorts))
  };

  const entered: string[] = [];
  cleanups.push(() => {
    if (entered.length === 0) return;
    docker(['rm', '-f', containerName], { timeoutMs: 120_000 });
    docker(['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], { env: composeEnv, timeoutMs: 300_000 });
  });

  const compose: ComposeDependencies = {
    network: '',
    objectStoreService: 'objectstore',
    databaseUrl: '',
    redisUrl: ''
  };
  /** Dependent steps refuse to run on a guessed network; a failed stack must not cascade. */
  const requireStack = (): void => {
    assert(
      compose.network !== '' && compose.databaseUrl !== '',
      'the compose dependency stack is not running, so this check cannot run'
    );
  };

  await step(
    'start postgres, redis and the object store from compose',
    'docker compose up -d --wait postgres redis <object store service>',
    async () => {
      assert(existsSync(composeFile), 'docker-compose.yml is missing');
      entered.push('compose');
      const started = await startComposeDependencies(composeFile, composeEnv);
      compose.network = started.network;
      compose.objectStoreService = started.objectStoreService;
      compose.databaseUrl = started.databaseUrl;
      compose.redisUrl = started.redisUrl;
      const ready = must('docker', ['compose', '-f', composeFile, 'ps', '--format', '{{.Service}} {{.Health}}'], {
        env: composeEnv
      }).stdout.trim();
      return `healthy on network ${compose.network}: ${ready.split('\n').join('; ')}`;
    }
  );

  const tenantToken = `hf_e2e_${randomBytes(24).toString('hex')}`;
  const tenantDigest = createHash('sha256').update(tenantToken).digest('hex');
  const metricsToken = randomBytes(16).toString('hex');
  const tenantsFile = join(workDir, 'tenants.json');
  const gatewayCredential = 'Key e2e-id:e2e-secret';
  writeFileSync(
    tenantsFile,
    JSON.stringify(
      {
        tenants: [
          {
            tenantId: 'tenant-e2e',
            tokenId: 'token-e2e',
            tokenSha256: tenantDigest,
            expiresAt: '2035-01-01T00:00:00.000Z',
            audience: publicUrl,
            scopes: ['higgsfield:read', 'higgsfield:generate', 'higgsfield:upload'],
            providerCredentialsEnv: 'HF_E2E_CREDENTIALS',
            providerAccountId: 'acct-e2e'
          }
        ]
      },
      null,
      2
    ),
    'utf8'
  );

  await step(
    'apply database migrations before starting the gateway',
    `docker run --rm --read-only --tmpfs /tmp --network ${compose.network} ${imageTag} node apps/server/dist/cli.js migrate`,
    () => {
      requireStack();
      // Migrations run from the shipped image, which stages them at
      // `<dist>/migrations`; a workspace build does not copy the .sql files into dist.
      const migration = run(
        'docker',
        [
          'run',
          '--rm',
          '--read-only',
          '--tmpfs',
          '/tmp',
          '--network',
          compose.network,
          '--add-host',
          'host.docker.internal:host-gateway',
          '-e',
          `HF_MCP_DATABASE_URL=${compose.databaseUrl}`,
          '-e',
          'HF_MCP_LOG_LEVEL=error',
          '--entrypoint',
          'node',
          imageTag,
          'apps/server/dist/cli.js',
          'migrate'
        ],
        { timeoutMs: 300_000 }
      );
      assert(
        migration.status === 0 && migration.stdout.includes('migrate: applied'),
        `migrate failed (exit ${String(migration.status)}): ${(migration.stderr || migration.stdout).trim().slice(0, 400)}`
      );
      return migration.stdout.trim().split('\n')[0] ?? 'migrations applied';
    }
  );

  const containerEnv: Record<string, string> = {
    HF_MCP_TRANSPORT: 'http',
    HF_MCP_HOST: '0.0.0.0',
    HF_MCP_PORT: String(gatewayPort),
    HF_MCP_PUBLIC_URL: publicUrl,
    HF_MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
    HF_MCP_METRICS_TOKEN: metricsToken,
    HF_MCP_AUTH_MODE: 'static_token',
    HF_MCP_TENANTS_FILE: '/run/secrets/tenants.json',
    HF_E2E_CREDENTIALS: gatewayCredential,
    HF_MCP_PROVIDER_ACCOUNT_ID: 'acct-e2e',
    HF_MCP_PROVIDER_BASE_URL: fixture.internalUrl,
    HF_MCP_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    HF_MCP_DATABASE_URL: compose.databaseUrl,
    HF_MCP_REDIS_URL: compose.redisUrl,
    HF_MCP_LOG_LEVEL: 'info',
    HF_MCP_WORKERS_ENABLED: 'true'
  };

  const runArgs = [
    'run',
    '-d',
    '--name',
    containerName,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--network',
    compose.network,
    '--add-host',
    'host.docker.internal:host-gateway',
    '-p',
    `127.0.0.1:${String(gatewayPort)}:${String(gatewayPort)}`,
    '-v',
    `${tenantsFile}:/run/secrets/tenants.json:ro`
  ];
  for (const [key, value] of Object.entries(containerEnv)) runArgs.push('-e', `${key}=${value}`);
  runArgs.push(imageTag);

  await step(
    'run the container non-root, read-only, and serve /health, /ready and /metrics',
    `docker ${runArgs.join(' ')}`,
    async () => {
      requireStack();
      entered.push('container');
      must('docker', runArgs, { timeoutMs: 180_000 });
      await waitForContainerHttp(`${gatewayUrl}/health`, 90_000, containerName);

      const health = (await (await fetch(`${gatewayUrl}/health`)).json()) as { status?: string };
      assert(health.status === 'ok', `/health reported ${JSON.stringify(health)}`);

      const ready = await fetch(`${gatewayUrl}/ready`);
      const readyBody = (await ready.json()) as { status?: string; checks?: Record<string, boolean> };
      assert(
        ready.status === 200,
        `/ready returned ${String(ready.status)}: ${JSON.stringify({ status: readyBody.status, checks: readyBody.checks })}`
      );
      assert(readyBody.checks?.['repository'] === true, `repository readiness failed: ${JSON.stringify(readyBody.checks)}`);

      const unauthorized = await fetch(`${gatewayUrl}/metrics`);
      assert(unauthorized.status === 401, `GET /metrics without a token returned ${String(unauthorized.status)}`);
      const metrics = await fetch(`${gatewayUrl}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } });
      assert(metrics.status === 200, `GET /metrics with a token returned ${String(metrics.status)}`);
      const exposition = await metrics.text();
      assert(
        exposition.includes('mcp_tool_calls_total'),
        'the metrics exposition does not carry mcp_tool_calls_total'
      );

      const readonlyRoot = must('docker', ['inspect', containerName, '--format', '{{.HostConfig.ReadonlyRootfs}}']).stdout.trim();
      assert(readonlyRoot === 'true', `the container root filesystem is not read-only (${readonlyRoot})`);
      const uid = must('docker', [
        'exec',
        containerName,
        'node',
        '-e',
        'process.stdout.write(String(process.getuid()))'
      ]).stdout.trim();
      assert(uid !== '0', 'the container process is running as uid 0 (root)');

      return `health=${JSON.stringify(health)}, ready=${JSON.stringify(readyBody.checks ?? {})}, uid=${uid}, read_only=${readonlyRoot}`;
    }
  );

  await step('generate over HTTP MCP against the fixture provider', 'MCP POST /mcp higgsfield.generate_image', async () => {
    // Phase 1: submit, then prove the job is genuinely in flight (the fixture status
    // path stays unreleased) before the client is closed and the container is restarted.
    const jobId = await (async () => {
      const client = await connectHttp(`${gatewayUrl}/mcp`, tenantToken);
      try {
        const submitted = await client.callTool({
          name: 'higgsfield.generate_image',
          arguments: { prompt: 'a red ceramic cup on a marble counter', wait: false }
        });
        const failure = toolError(submitted);
        assert(failure === undefined, `higgsfield.generate_image failed: ${failure ?? ''}`);
        const id = structured(submitted)['job_id'];
        assert(typeof id === 'string' && id.length > 0, 'the submission returned no job_id');
        // The submission is persisted first and POSTed by the worker on its next tick,
        // so wait for the fixture to observe it rather than racing the worker.
        const observedBy = Date.now() + 20_000;
        while (fixture.submissions.length === 0 && Date.now() < observedBy) {
          const tick = Promise.withResolvers<void>();
          setTimeout(tick.resolve, 250);
          await tick.promise;
        }
        const firstSubmission = fixture.submissions[0];
        assert(firstSubmission !== undefined, 'the fixture provider never received the submission within 20s');
        assert(
          typeof firstSubmission.idempotencyKey === 'string' && firstSubmission.idempotencyKey !== '',
          'the provider request carried no Idempotency-Key header'
        );

        const settle = Promise.withResolvers<void>();
        setTimeout(settle.resolve, 3_000);
        await settle.promise;
        const inFlight = structured(await client.callTool({ name: 'higgsfield.jobs.get', arguments: { job_id: id } }));
        assert(
          inFlight['status'] === 'queued' || inFlight['status'] === 'processing',
          `the job should still be in flight before the restart, saw ${String(inFlight['status'])}`
        );
        assert(fixture.polls() > 0, 'the worker never polled the fixture status endpoint');
        return id;
      } finally {
        await client.close();
      }
    })();

    // Phase 2: SIGTERM the container and bring it back. The job only survives because it
    // is persisted in Postgres; the memory repository is not in play here.
    const stopped = docker(['stop', '-t', '30', containerName], { timeoutMs: 120_000 });
    assert(stopped.status === 0, `docker stop failed: ${stopped.stderr.trim()}`);
    const exitCode = must('docker', ['inspect', containerName, '--format', '{{.State.ExitCode}}']).stdout.trim();
    assert(exitCode === '0', `the gateway exited ${exitCode} on SIGTERM instead of shutting down cleanly`);
    must('docker', ['start', containerName], { timeoutMs: 120_000 });
    await waitForContainerHttp(`${gatewayUrl}/health`, 90_000, containerName);

    // Phase 3: the job must still be there, then finish once the provider completes it.
    const client = await connectHttp(`${gatewayUrl}/mcp`, tenantToken);
    try {
      const survived = structured(await client.callTool({ name: 'higgsfield.jobs.get', arguments: { job_id: jobId } }));
      assert(survived['job_id'] === jobId, 'the job did not survive the restart');
      fixture.release();
      const finished = structured(
        await client.callTool({ name: 'higgsfield.jobs.wait', arguments: { job_id: jobId, timeout_ms: 25_000 } })
      );
      assert(finished['status'] === 'completed', `the job finished as ${String(finished['status'])}`);
      const assets = finished['assets'];
      assert(Array.isArray(assets) && assets.length === 1, `expected one asset, saw ${JSON.stringify(assets)}`);
      const asset = assets[0] as JsonObject;
      assert(asset['url'] === 'https://cdn.example.com/fixture-output.png', `unexpected asset url ${String(asset['url'])}`);
      const fetched = structured(
        await client.callTool({ name: 'higgsfield.media.get', arguments: { asset_id: String(asset['asset_id']) } })
      );
      assert(fetched['asset_id'] === asset['asset_id'], 'media.get returned a different asset');
      return `job ${jobId} survived SIGTERM/restart (exit ${exitCode}), completed with asset ${String(asset['asset_id'])}, ${String(fixture.polls())} provider poll(s)`;
    } finally {
      await client.close();
    }
  });

  await step('reject an unauthenticated MCP request', 'POST /mcp without a bearer token', async () => {
    const response = await fetch(`${gatewayUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    assert(response.status === 401, `an unauthenticated /mcp request returned ${String(response.status)}`);
    return `unauthenticated /mcp -> ${String(response.status)}`;
  });
}

/* --------------------------------------------------------------------- live */

interface LiveBudget {
  capMicroUsd: number;
  spentMicroUsd: number;
}

function parseUsd(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Runs one paid tool call through the gateway's confirmation flow so the estimate is
 * always produced by the gateway before anything is submitted, then enforces the budget.
 */
async function paidCall(
  client: Client,
  budget: LiveBudget,
  tool: string,
  args: JsonObject
): Promise<JsonObject> {
  const first = await client.callTool({ name: tool, arguments: { ...args } });
  const failure = toolError(first);
  assert(failure === undefined, `${tool} failed before confirmation: ${failure ?? ''}`);
  const pending = structured(first);
  assert(
    pending['status'] === 'confirmation_required',
    `${tool} did not return confirmation_required; refusing to spend without an estimate (${JSON.stringify(pending).slice(0, 200)})`
  );
  const estimateUsd = parseUsd(pending['estimated_cost_usd']);
  assert(estimateUsd !== undefined, `${tool} returned confirmation_required without an estimated_cost_usd`);
  const estimateMicroUsd = Math.round(estimateUsd * 1_000_000);
  const remaining = budget.capMicroUsd - budget.spentMicroUsd;
  assert(
    estimateMicroUsd <= remaining,
    `${tool} estimated $${estimateUsd.toFixed(6)} which exceeds the remaining budget of $${(remaining / 1_000_000).toFixed(6)}`
  );
  const token = pending['confirmation_token'];
  assert(typeof token === 'string' && token.length > 0, `${tool} returned no confirmation_token`);

  const second = await client.callTool({ name: tool, arguments: { ...args, confirmation_token: token } });
  const secondFailure = toolError(second);
  assert(secondFailure === undefined, `${tool} failed after confirmation: ${secondFailure ?? ''}`);
  const job = structured(second);
  assert(job['status'] !== 'confirmation_required', `${tool} asked for confirmation twice`);
  budget.spentMicroUsd += estimateMicroUsd;
  log(`     paid ${tool}: estimated $${estimateUsd.toFixed(6)}, budget spent $${(budget.spentMicroUsd / 1_000_000).toFixed(6)}`);
  return job;
}

async function awaitJob(client: Client, jobId: string, timeoutMs = 600_000): Promise<JsonObject> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonObject = {};
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: 'higgsfield.jobs.wait', arguments: { job_id: jobId, timeout_ms: 25_000 } });
    const failure = toolError(result);
    assert(failure === undefined, `higgsfield.jobs.wait failed: ${failure ?? ''}`);
    last = structured(result);
    const status = last['status'];
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return last;
  }
  throw new Error(`job ${jobId} did not reach a terminal state in ${String(timeoutMs)}ms (last ${JSON.stringify(last).slice(0, 200)})`);
}

async function liveProfile(): Promise<void> {
  const credentials = process.env['HF_API_CREDENTIALS'];
  const budgetUsd = Number.parseFloat(process.env['HF_MCP_LIVE_MAX_USD'] ?? '');
  const enabled = process.env['HF_MCP_LIVE_E2E'] === '1';
  if (!enabled || credentials === undefined || credentials === '' || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    const detail =
      'live validation not run: HF_MCP_LIVE_E2E=1, HF_API_CREDENTIALS and a positive HF_MCP_LIVE_MAX_USD are all required';
    results.push({ name: 'live provider acceptance', ok: false, command: 'HF_MCP_LIVE_E2E=1 ...', detail });
    log(`live validation not run: set HF_MCP_LIVE_E2E=1, HF_API_CREDENTIALS and HF_MCP_LIVE_MAX_USD`);
    return;
  }

  const binary = resolve(process.env['HF_MCP_E2E_BIN'] ?? join(repoRoot, 'apps/server/dist/cli.js'));
  const env: Record<string, string> = {
    HF_API_CREDENTIALS: credentials,
    HF_MCP_TRANSPORT: 'stdio',
    HF_MCP_LOG_LEVEL: 'error',
    HF_MCP_REQUIRE_CONFIRM_ABOVE_USD: '0',
    HF_MCP_WORKERS_ENABLED: 'true'
  };
  const liveDir = mkdtempSync(join(tmpdir(), 'hf-live-e2e-'));
  cleanups.push(() => rmSync(liveDir, { recursive: true, force: true }));
  const budget: LiveBudget = { capMicroUsd: Math.round(budgetUsd * 1_000_000), spentMicroUsd: 0 };

  await step('live: locate the gateway CLI', `${binary} serve --transport stdio`, () => {
    assert(existsSync(binary), `${binary} does not exist; run pnpm build (or set HF_MCP_E2E_BIN) before the live profile`);
    return `using ${binary}`;
  });
  if (results.some((result) => !result.ok)) return;

  const { client } = await connectStdio(process.execPath, [binary, 'serve', '--transport', 'stdio'], env);
  cleanups.push(() => client.close());

  await step('live: capabilities and model discovery', 'higgsfield.capabilities / higgsfield.models.list', async () => {
    const capabilities = structured(await client.callTool({ name: 'higgsfield.capabilities', arguments: {} }));
    const models = structured(await client.callTool({ name: 'higgsfield.models.list', arguments: {} }));
    const list = models['models'];
    assert(Array.isArray(list) && list.length > 0, 'no models were returned');
    return `gateway ${String(capabilities['gateway_version'])}, ${String(list.length)} models, budget $${budgetUsd.toFixed(2)}`;
  });

  await step('live: generate an image within budget', 'higgsfield.generate_image (confirmation-gated)', async () => {
    const job = await paidCall(client, budget, 'higgsfield.generate_image', {
      prompt: 'a red ceramic cup on a marble counter, soft daylight',
      wait: false
    });
    const jobId = String(job['job_id']);
    const finished = await awaitJob(client, jobId);
    assert(finished['status'] === 'completed', `image job ended as ${String(finished['status'])}`);
    const assets = finished['assets'];
    assert(Array.isArray(assets) && assets.length > 0, 'the completed image job carried no assets');
    writeFileSync(join(liveDir, 'image-job.json'), JSON.stringify(finished, null, 2), 'utf8');
    return `job ${jobId} completed with ${String(assets.length)} asset(s)`;
  });

  await step('live: edit the generated image', 'higgsfield.edit_image (confirmation-gated)', async () => {
    const previous = JSON.parse(readFileSync(join(liveDir, 'image-job.json'), 'utf8')) as JsonObject;
    const assets = previous['assets'] as JsonObject[];
    const asset = assets[0];
    assert(asset !== undefined, 'no source asset is available for the edit');
    const job = await paidCall(client, budget, 'higgsfield.edit_image', {
      prompt: 'replace the background with a warm linen tablecloth',
      image: { type: 'asset', asset_id: String(asset['asset_id']) },
      wait: false
    });
    const finished = await awaitJob(client, String(job['job_id']));
    assert(finished['status'] === 'completed', `edit job ended as ${String(finished['status'])}`);
    writeFileSync(join(liveDir, 'edit-job.json'), JSON.stringify(finished, null, 2), 'utf8');
    return `edit job ${String(finished['job_id'])} completed`;
  });

  await step('live: image to video', 'higgsfield.animate_image (confirmation-gated)', async () => {
    const previous = JSON.parse(readFileSync(join(liveDir, 'image-job.json'), 'utf8')) as JsonObject;
    const assets = previous['assets'] as JsonObject[];
    const asset = assets[0];
    assert(asset !== undefined, 'no source asset is available for the animation');
    const job = await paidCall(client, budget, 'higgsfield.animate_image', {
      prompt: 'slow push-in, steam rising from the cup',
      image: { type: 'asset', asset_id: String(asset['asset_id']) },
      wait: false
    });
    const jobId = String(job['job_id']);
    const queued = structured(await client.callTool({ name: 'higgsfield.jobs.get', arguments: { job_id: jobId } }));
    const finished = await awaitJob(client, jobId);
    assert(finished['status'] === 'completed', `video job ended as ${String(finished['status'])}`);
    writeFileSync(join(liveDir, 'video-job.json'), JSON.stringify(finished, null, 2), 'utf8');
    return `video job ${jobId} completed after ${String(queued['status'])}`;
  });

  await step('live: retrieve outputs', 'higgsfield.jobs.get / higgsfield.media.get', async () => {
    const previous = JSON.parse(readFileSync(join(liveDir, 'video-job.json'), 'utf8')) as JsonObject;
    const assets = previous['assets'] as JsonObject[];
    assert(assets.length > 0, 'the video job carried no assets');
    const asset = structured(
      await client.callTool({ name: 'higgsfield.media.get', arguments: { asset_id: String((assets[0] as JsonObject)['asset_id']) } })
    );
    assert(typeof asset['url'] === 'string' && asset['url'] !== '', 'media.get returned no url');
    return `retrieved ${String(asset['asset_id'])} (${String(asset['media_type'])}, ${String(asset['url']).slice(0, 60)}...)`;
  });

  await step('live: queued cancellation', 'higgsfield.jobs.cancel', async () => {
    const job = await paidCall(client, budget, 'higgsfield.generate_video', {
      prompt: 'a slow pan across a misty lake at dawn',
      wait: false
    });
    const cancelled = structured(
      await client.callTool({ name: 'higgsfield.jobs.cancel', arguments: { job_id: String(job['job_id']) } })
    );
    const status = cancelled['status'];
    assert(
      status === 'cancelled' || status === 'queued' || status === 'processing',
      `unexpected cancellation state ${String(status)}`
    );
    return `cancel returned ${String(status)} for job ${String(job['job_id'])}`;
  });

  if (process.env['HF_MCP_LIVE_SOUL'] === '1') {
    await step('live: Soul ID training (explicitly enabled)', 'higgsfield.generate (soul-id)', async () => {
      const imageUrl = process.env['HF_MCP_LIVE_SOUL_IMAGE_URL'];
      assert(imageUrl !== undefined && imageUrl !== '', 'HF_MCP_LIVE_SOUL_IMAGE_URL is required to train a Soul ID');
      const job = await paidCall(client, budget, 'higgsfield.generate', {
        endpoint: 'soul-id',
        input: {
          name: 'e2e-soul',
          model_version: 'v1',
          input_images: [{ type: 'image_url', image_url: imageUrl }]
        },
        wait: false
      });
      return `soul-id job ${String(job['job_id'])} submitted (training runs asynchronously)`;
    });
  } else {
    skip('live: Soul ID training', 'higgsfield.generate (soul-id)', 'set HF_MCP_LIVE_SOUL=1 to enable paid Soul ID training');
  }

  log(`live spend: $${(budget.spentMicroUsd / 1_000_000).toFixed(6)} of $${budgetUsd.toFixed(2)} budgeted`);
}

/* ---------------------------------------------------------------------- cli */

const USAGE = `usage: pnpm test:e2e --profile <distribution|live>
  distribution   build, pack, install, stdio discovery, container gate (default)
  live           paid provider acceptance; requires HF_MCP_LIVE_E2E=1, HF_API_CREDENTIALS and HF_MCP_LIVE_MAX_USD`;

function parseProfile(argv: readonly string[]): Profile | number {
  let profile: Profile = 'distribution';
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const inline = token.startsWith('--profile=') ? token.slice('--profile='.length) : undefined;
    // `pnpm test:e2e -- --profile x` forwards the separator; ignore it.
    if (token === '--') continue;
    if (token === '--profile' || inline !== undefined) {
      const value = inline ?? argv[index + 1];
      if (value !== 'distribution' && value !== 'live') {
        process.stderr.write(`unknown profile: ${String(value)}\n${USAGE}\n`);
        return 2;
      }
      profile = value;
      if (inline === undefined) index += 1;
      continue;
    }
    process.stderr.write(`unknown argument: ${token}\n${USAGE}\n`);
    return 2;
  }
  return profile;
}

async function main(): Promise<number> {
  const profile = parseProfile(process.argv.slice(2));
  if (typeof profile === 'number') return profile;

  log(`e2e profile: ${profile}`);
  try {
    if (profile === 'distribution') await distributionProfile();
    else await liveProfile();
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // Best-effort teardown: never mask the gate result.
      }
    }
  }

  const failures = results.filter((result) => !result.ok);
  log(`\n${String(results.length - failures.length)}/${String(results.length)} steps passed`);
  for (const failure of failures) log(`  FAIL ${failure.name}: ${failure.detail}`);
  return failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
