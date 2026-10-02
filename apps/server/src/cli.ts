import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthContext, GenerationJob, StructuredError } from '@higgsfield-mcp/core';
import { GatewayError, toStructuredError } from '@higgsfield-mcp/core';
import type { CliOverrides, GatewayConfig } from '@higgsfield-mcp/config';
import { ConfigValidationError, loadConfig, parseGlobalFlags } from '@higgsfield-mcp/config';
import { checkUpstream, loadManifest, syncSkills, validateSkills } from '@higgsfield-mcp/skills';
import { loadBundledCatalog } from '@higgsfield-mcp/provider-higgsfield';
import { createContainer, migrate, type GatewayContainer } from './composition.js';
import { resolveSkillsDir } from './skills-dir.js';
import { startHttpServer } from './transport/http.js';
import { serveStdioServer } from './transport/stdio.js';
import { createWebhookHandler } from './webhooks/higgsfield.js';
import { GATEWAY_VERSION, MCP_PROTOCOL_REVISION } from './version.js';

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_FAILURE = 1;

interface CommandSpec {
  command: string;
  positionals: string[];
  flags: CliOverrides;
  extra: Record<string, string>;
}

const EXTRA_FLAGS_BY_COMMAND: Readonly<Record<string, readonly string[]>> = {
  'jobs reconcile': ['provider-job-id', 'tenant'],
  'skills sync': ['upstream'],
  'skills check-upstream': []
};

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

function parseCommand(argv: readonly string[]): CommandSpec {
  const tokens = [...argv];
  const command = tokens.shift() ?? 'serve';
  const sub = tokens[0] !== undefined && !tokens[0].startsWith('-') ? tokens[0] : undefined;
  const key = sub === undefined ? command : `${command} ${sub}`;
  const allowedExtra = EXTRA_FLAGS_BY_COMMAND[key] ?? [];
  const extra: Record<string, string> = {};
  const remaining: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (sub !== undefined && index === 0) continue;
    const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(token);
    if (match === null) {
      remaining.push(token);
      continue;
    }
    const name = match[1] as string;
    if (!allowedExtra.includes(name)) {
      remaining.push(token);
      continue;
    }
    const value = match[2] ?? tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new GatewayError('INVALID_INPUT', `Flag --${name} requires a value.`);
    }
    extra[name] = value;
    if (match[2] === undefined) index += 1;
  }
  const parsed = parseGlobalFlags(remaining);
  return { command: key, positionals: parsed.positionals, flags: parsed.flags, extra };
}

function loadGatewayConfig(spec: CommandSpec, argv: readonly string[]): GatewayConfig {
  return loadConfig({ argv, env: process.env, overrides: spec.flags });
}

/**
 * Operator-facing error text. MCP responses stay sanitized, but the CLI is run by a
 * human: an infrastructure failure (`ECONNREFUSED`, `ETIMEDOUT`) must say so instead
 * of collapsing into "Unexpected gateway failure".
 */
function describeError(error: unknown): string {
  if (error instanceof GatewayError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  const structured: StructuredError = toStructuredError(error);
  return `${structured.code}: ${structured.message}`;
}

async function runServe(spec: CommandSpec, argv: readonly string[]): Promise<number> {
  const config = loadGatewayConfig(spec, argv);
  const container = await createContainer(config);
  const shutdown = async (signal: string): Promise<void> => {
    container.logger.info({ event: 'gateway.signal', signal }, 'Shutting down');
    await container.stopAdmission();
    if (config.transport === 'stdio') {
      await container.shutdown();
      process.exit(EXIT_OK);
    }
    const graceMs = config.server.shutdownGraceMs;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, graceMs);
    await promise;
    await container.shutdown();
    process.exit(EXIT_OK);
  };

  if (config.transport === 'stdio') {
    const localAuth: AuthContext = container.auth.localContext();
    const server = await serveStdioServer({
      deps: container.mcpDeps,
      logger: container.logger,
      context: () => ({
        requestId: `req_stdio_${Date.now().toString(36)}`,
        tenantId: localAuth.tenantId,
        transport: 'stdio',
        auth: localAuth
      }),
      onClose: () => container.shutdown()
    });
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.stdin.on('end', () => void server.close());
    return EXIT_OK;
  }

  const webhook = createWebhookHandler({
    repository: container.repository,
    logger: container.logger,
    metrics: container.metrics,
    nudge: (jobId) => container.worker.nudge(jobId),
    ...(config.server.publicUrl === undefined ? {} : { publicUrl: config.server.publicUrl })
  });
  const http = await startHttpServer({
    config,
    deps: container.mcpDeps,
    auth: container.auth,
    logger: container.logger,
    metrics: container.metrics,
    webhook,
    readiness: container.readiness,
    contextFor: (auth, workspaceId) => {
      const context = {
        requestId: `req_http_${Date.now().toString(36)}`,
        tenantId: auth.tenantId,
        transport: 'http' as const,
        auth
      };
      return workspaceId === undefined ? context : { ...context, workspaceId };
    }
  });
  process.on('SIGTERM', async () => {
    http.stopAdmission();
    await shutdown('SIGTERM');
  });
  process.on('SIGINT', async () => {
    http.stopAdmission();
    await shutdown('SIGINT');
  });
  return EXIT_OK;
}

async function runDoctor(spec: CommandSpec): Promise<number> {
  const config = loadGatewayConfig(spec, []);
  let failures = 0;
  const report = (name: string, ok: boolean, detail: string): void => {
    if (!ok) failures += 1;
    out(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  };

  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  report('node', major >= 22, `version ${process.versions.node} (requires >= 22)`);
  report('transport', true, `${config.transport} on ${config.server.host}:${config.server.port}`);
  report('auth', config.auth.mode !== 'none' || config.transport === 'stdio', `mode ${config.auth.mode}`);

  const container = await createContainer(config);
  for (const [name, ok] of Object.entries((await container.readiness()).checks)) {
    report(name, ok, ok ? 'reachable' : 'unavailable');
  }

  report(
    'allowed_paths',
    true,
    config.media.allowedPaths.length === 0
      ? 'empty (local file inputs denied)'
      : config.media.allowedPaths.join(', ')
  );
  for (const path of config.media.allowedPaths) {
    let ok = false;
    let detail = 'not a directory';
    try {
      ok = statSync(path).isDirectory();
      detail = ok ? 'directory present' : 'not a directory';
    } catch {
      detail = 'missing';
    }
    report(`allowed_path:${path}`, ok, detail);
  }

  report('asset_mode', true, config.media.assetMode);
  report(
    'database',
    config.persistence.databaseUrl !== undefined ? true : config.mode === 'local',
    config.persistence.databaseUrl === undefined ? 'not configured' : 'configured'
  );
  report(
    'redis',
    config.persistence.redisUrl !== undefined ? true : config.mode === 'local',
    config.persistence.redisUrl === undefined ? 'not configured' : 'configured'
  );

  let skillsDetail = 'no generated skills tree found';
  let skillsOk = config.transport === 'stdio';
  const skillsDir = resolveSkillsDir(config.skillsDir);
  if (skillsDir !== undefined) {
    try {
      const manifest = loadManifest(skillsDir);
      const counts = new Map<string, number>();
      for (const skill of manifest.skills) counts.set(skill.status, (counts.get(skill.status) ?? 0) + 1);
      skillsDetail = `upstream ${manifest.upstream.version} (${[...counts]
        .map(([status, count]) => `${status}=${count}`)
        .join(' ')})`;
      skillsOk = true;
    } catch (error) {
      skillsDetail = `manifest unreadable (${describeError(error)})`;
      skillsOk = false;
    }
  }
  report('skills', skillsOk, skillsDetail);

  await container.shutdown();
  out(failures === 0 ? 'doctor: all checks passed' : `doctor: ${failures} check(s) failed`);
  return failures === 0 ? EXIT_OK : EXIT_FAILURE;
}

/**
 * Reports the same catalog the MCP `higgsfield.models.list` surface publishes, so the
 * CLI and the server can never contradict each other. Execution support is printed
 * explicitly: a documented workflow this gateway cannot run is not a runnable model.
 */
async function runModels(spec: CommandSpec): Promise<number> {
  const config = loadGatewayConfig(spec, []);
  const container = await createContainer(config);
  try {
    const { models, catalog } = await container.discovery.list();
    out(
      `catalog\t${catalog.source}\t${catalog.source_url}\tfetched_at=${catalog.fetched_at}` +
        `\tstale=${String(catalog.stale)}\ttotal=${catalog.total}\treturned=${catalog.returned}`
    );
    for (const warning of catalog.warnings) out(`warn ${warning}`);
    for (const model of models) {
      const execution = model.execution.supported
        ? 'supported'
        : `unsupported:${model.execution.reason ?? 'unknown'}`;
      out(
        [
          model.id,
          model.type,
          model.endpoint ?? '(undocumented)',
          execution,
          `schema=${model.schemaStatus}`,
          `capabilities=${model.capabilities.length === 0 ? '(none verified)' : model.capabilities.join(',')}`,
          `source=${model.source.url}`
        ].join('\t')
      );
    }
    return EXIT_OK;
  } catch (error) {
    err(`models: ${describeError(error)}`);
    err('model discovery reads the public Higgsfield documentation directory; check access to https://docs.higgsfield.ai');
    return EXIT_FAILURE;
  } finally {
    await container.shutdown();
  }
}

function runSkillsList(spec: CommandSpec): number {
  const config = loadGatewayConfig(spec, []);
  const skillsDir = resolveSkillsDir(config.skillsDir);
  if (skillsDir === undefined) {
    out('skills: no generated skills tree found (set HF_MCP_SKILLS_DIR or run pnpm skills:sync)');
    return EXIT_OK;
  }
  const manifest = loadManifest(skillsDir);
  out(`upstream: ${manifest.upstream.repository}@${manifest.upstream.commit}`);
  out(`upstream version: ${manifest.upstream.version} adapter: ${manifest.adapterVersion}`);
  for (const skill of manifest.skills) {
    const workflows = skill.workflows.length === 0 ? '' : ` workflows=${skill.workflows.join(',')}`;
    out(`${skill.name}\t${skill.status}${workflows}\t${skill.reason}`);
  }
  return EXIT_OK;
}

/** Source checkout root: the cwd for dev-time commands, else the location of this file. */
function findRepoRoot(): string {
  const candidates = [process.cwd(), resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'packages', 'skills', 'manifest.json'))) return candidate;
  }
  return process.cwd();
}

async function runSkillsSync(spec: CommandSpec): Promise<number> {
  const repoRoot = findRepoRoot();
  const upstream = spec.extra['upstream'] ?? '';
  const result = await syncSkills({
    repoRoot,
    upstream,
    sourceDir: join(repoRoot, 'packages', 'skills', 'source'),
    patchesDir: join(repoRoot, 'packages', 'skills', 'patches'),
    generatedDir: join(repoRoot, 'packages', 'skills', 'generated'),
    log: out
  });
  out(`skills: synced ${result.commit} (v${result.version}), ${result.generated.length} skill(s) generated`);
  return EXIT_OK;
}

async function runSkillsCheckUpstream(_spec: CommandSpec): Promise<number> {
  const repoRoot = findRepoRoot();
  const report = await checkUpstream({ repoRoot, repository: 'higgsfield-ai/skills', log: out });
  out(
    `pinned ${report.pinnedCommit} / upstream ${report.upstreamHead} (v${report.upstreamVersion}) -> ${
      report.drifted ? 'drifted' : 'in sync'
    }`
  );
  return report.drifted ? EXIT_FAILURE : EXIT_OK;
}

async function runSkillsValidate(spec: CommandSpec): Promise<number> {
  const config = loadGatewayConfig(spec, []);
  const repoRoot = findRepoRoot();
  const skillsDir = resolveSkillsDir(config.skillsDir) ?? join(repoRoot, 'skills');
  if (!existsSync(join(skillsDir, 'manifest.json'))) {
    err(`skills: no manifest found at ${skillsDir}`);
    return EXIT_FAILURE;
  }
  const registryEndpointIds = loadBundledCatalog().map((model) => model.endpoint);
  const result = await validateSkills({ skillsDir, repoRoot, registryEndpointIds });
  for (const warning of result.warnings) out(`warn ${warning}`);
  for (const error of result.errors) err(`FAIL ${error}`);
  out(`skills: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  return result.errors.length === 0 ? EXIT_OK : EXIT_FAILURE;
}

async function runMigrate(spec: CommandSpec): Promise<number> {
  const config = loadGatewayConfig(spec, []);
  const result = await migrate(config);
  out(`migrate: applied ${result.applied.length} migration(s)`);
  for (const name of result.applied) out(`  ${name}`);
  return EXIT_OK;
}

async function runJobsReconcile(spec: CommandSpec): Promise<number> {
  const jobId = spec.positionals[1];
  const providerJobId = spec.extra['provider-job-id'];
  const tenant = spec.extra['tenant'];
  if (jobId === undefined || providerJobId === undefined || tenant === undefined) {
    err('usage: higgsfield-mcp jobs reconcile <job-id> --provider-job-id <id> --tenant <tenant>');
    return EXIT_USAGE;
  }
  const config = loadGatewayConfig(spec, []);
  const container = await createContainer(config);
  const handle = providerJobId.includes(':') ? providerJobId : `generation:${providerJobId}`;
  const context = { requestId: `req_reconcile_${Date.now().toString(36)}`, tenantId: tenant, transport: 'stdio' as const };
  const provider = await container.providerFactory.forContext(context);
  const snapshot = await provider.getJob(handle);
  const attached: GenerationJob | undefined = await container.repository.transaction(async (tx) => {
    const envelope = await tx.getSubmission(tenant, jobId);
    if (envelope === undefined) {
      throw new GatewayError('JOB_NOT_FOUND', `Job ${jobId} was not found for tenant ${tenant}.`);
    }
    const now = new Date().toISOString();
    await tx.updateSubmission(tenant, jobId, {
      state: 'acknowledged',
      providerJobId: handle,
      lastAttemptAt: now,
      nextAttemptAt: undefined,
      lastError: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined
    });
    return tx.updateJob(
      tenant,
      jobId,
      { updatedAt: now, metadata: { reconciled: true, provider_status: snapshot.status } },
      { expectStatus: ['queued', 'processing'] }
    );
  });
  container.worker.nudge(jobId);
  out(`reconciled ${jobId} -> ${handle} (provider status: ${snapshot.status})`);
  if (attached === undefined) out('note: the job was already terminal; only the provider binding was updated');
  await container.shutdown();
  return EXIT_OK;
}

function runVersion(): number {
  out(
    JSON.stringify(
      {
        name: 'higgsfield-mcp',
        version: GATEWAY_VERSION,
        mcp_protocol: MCP_PROTOCOL_REVISION,
        node: process.versions.node
      },
      null,
      2
    )
  );
  return EXIT_OK;
}

export async function main(argv: readonly string[]): Promise<number> {
  const spec = parseCommand(argv);
  switch (spec.command) {
    case 'serve':
      return runServe(spec, argv);
    case 'doctor':
      return runDoctor(spec);
    case 'models':
      return runModels(spec);
    case 'skills list':
      return runSkillsList(spec);
    case 'skills sync':
      return runSkillsSync(spec);
    case 'skills check-upstream':
      return runSkillsCheckUpstream(spec);
    case 'skills validate':
      return runSkillsValidate(spec);
    case 'version':
      return runVersion();
    case 'migrate':
      return runMigrate(spec);
    case 'jobs reconcile':
      return runJobsReconcile(spec);
    default:
      err(`unknown command: ${spec.command}`);
      err(
        'commands: serve, doctor, models, skills list, skills sync, skills check-upstream, skills validate, version, migrate, jobs reconcile'
      );
      return EXIT_USAGE;
  }
}

/**
 * True when this file is the process entry point. `realpathSync` is required because
 * package managers install the binary as a symlink (`node_modules/.bin/higgsfield-mcp`),
 * whose path does not end in `cli.js`.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return /(cli\.(js|ts)|higgsfield-mcp)$/.test(entry);
  }
}

const isDirectRun = isEntryPoint();
if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== EXIT_OK) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${describeError(error)}\n`);
      if (error instanceof ConfigValidationError) {
        for (const issue of error.issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
      }
      process.exitCode = EXIT_FAILURE;
    });
}

export type { GatewayContainer };
