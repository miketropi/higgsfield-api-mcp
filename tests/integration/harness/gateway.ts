import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayConfig } from '@higgsfield-mcp/config';
import { loadConfig, loadTenantsFile } from '@higgsfield-mcp/config';
import type {
  AuthContext,
  GenerationService,
  JobRepository,
  JobService,
  MediaService,
  ModelRegistry,
  RateLimiter,
  RequestContext,
  SubmissionWorker
} from '@higgsfield-mcp/core';
import { createMemoryRateLimiter, sha256Hex } from '@higgsfield-mcp/core';
import { createAuthService, httpRequestContext, type AuthService } from '@higgsfield-mcp/server/auth.js';
import {
  startHttpServer,
  type HttpServerHandle
} from '@higgsfield-mcp/server/transport/http.js';
import { createWebhookHandler } from '@higgsfield-mcp/server/webhooks/higgsfield.js';
import { createTestDeps } from './deps.js';
import type { TestDeps, TestMetrics } from './deps.js';
import type { FakeProvider, RecordingLogger } from '../../fixtures/fakes.js';

export const TEST_TOKEN = 'test-bearer-token-0123456789abcdef';
export const EXPIRED_TOKEN = 'expired-bearer-token-0123456789abcd';
export const PUBLIC_URL = 'https://gateway.test.example';
export const METRICS_TOKEN = 'metrics-token-0123456789';

export interface TenantSpec {
  tenantId: string;
  token: string;
  scopes: string[];
  expiresAt: string;
  credentials: string;
  accountId: string;
  tokenId: string;
}

export interface TestGateway {
  config: GatewayConfig;
  repository: JobRepository;
  registry: ModelRegistry;
  provider: FakeProvider;
  media: MediaService;
  jobs: JobService;
  generation: GenerationService;
  worker: SubmissionWorker;
  rateLimiter: RateLimiter;
  auth: AuthService;
  logger: RecordingLogger;
  metrics: TestMetrics;
  http: HttpServerHandle;
  url: string;
  graph: TestDeps;
  tenant(tenantId: string): TenantSpec;
  contextFor(tenantId: string): RequestContext;
  close(): Promise<void>;
}

export interface TestGatewayOptions {
  tenants?: TenantSpec[] | undefined;
  localFileAccess?: boolean | undefined;
  allowedOrigins?: string[] | undefined;
}

export function defaultTenants(): TenantSpec[] {
  return [
    {
      tenantId: 'tenant-a',
      token: TEST_TOKEN,
      scopes: ['higgsfield:read', 'higgsfield:generate', 'higgsfield:upload'],
      expiresAt: '2035-01-01T00:00:00.000Z',
      credentials: 'Key aaa:secret-a',
      accountId: 'acct-a',
      tokenId: 'token-a'
    },
    {
      tenantId: 'tenant-b',
      token: 'second-bearer-token-0123456789abcdef',
      scopes: ['higgsfield:read', 'higgsfield:generate', 'higgsfield:upload'],
      expiresAt: '2035-01-01T00:00:00.000Z',
      credentials: 'Key bbb:secret-b',
      accountId: 'acct-b',
      tokenId: 'token-b'
    },
    {
      tenantId: 'tenant-expired',
      token: EXPIRED_TOKEN,
      scopes: ['higgsfield:read', 'higgsfield:generate'],
      expiresAt: '2020-01-01T00:00:00.000Z',
      credentials: 'Key ccc:secret-c',
      accountId: 'acct-c',
      tokenId: 'token-expired'
    }
  ];
}

function credentialsEnvName(tenantId: string): string {
  return `HF_MCP_TEST_CREDENTIALS_${tenantId.toUpperCase().replaceAll('-', '_')}`;
}

function writeTenantsFile(tenants: TenantSpec[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'hf-tenants-'));
  const path = join(dir, 'tenants.json');
  writeFileSync(
    path,
    JSON.stringify({
      tenants: tenants.map((tenant) => ({
        tenantId: tenant.tenantId,
        tokenId: tenant.tokenId,
        tokenSha256: sha256Hex(tenant.token),
        expiresAt: tenant.expiresAt,
        audience: PUBLIC_URL,
        scopes: tenant.scopes,
        providerCredentialsEnv: credentialsEnvName(tenant.tenantId),
        providerAccountId: tenant.accountId
      }))
    }),
    'utf8'
  );
  return path;
}

export async function startTestGateway(options: TestGatewayOptions = {}): Promise<TestGateway> {
  const tenants = options.tenants ?? defaultTenants();
  const tenantsFile = writeTenantsFile(tenants);
  const env: Record<string, string> = {
    HF_API_CREDENTIALS: 'Key aaa:secret-a',
    HF_MCP_AUTH_MODE: 'static_token',
    HF_MCP_TENANTS_FILE: tenantsFile,
    HF_MCP_DATABASE_URL: 'postgres://gateway:gateway@127.0.0.1:5432/gateway',
    HF_MCP_REDIS_URL: 'redis://127.0.0.1:6379',
    HF_MCP_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    HF_MCP_PROVIDER_ACCOUNT_ID: 'acct-harness',
    HF_MCP_PUBLIC_URL: PUBLIC_URL,
    HF_MCP_METRICS_TOKEN: METRICS_TOKEN,
    HF_MCP_ALLOWED_PATHS: '/tmp',
    ...(options.allowedOrigins === undefined ? {} : { HF_MCP_ALLOWED_ORIGINS: options.allowedOrigins.join(',') })
  };
  for (const tenant of tenants) env[credentialsEnvName(tenant.tenantId)] = tenant.credentials;

  const requestedPort = 20_000 + Math.floor(Math.random() * 20_000);
  const config = loadConfig({ env, overrides: { transport: 'http', host: '127.0.0.1', port: requestedPort } });
  const tenantRecords = loadTenantsFile(tenantsFile).tenants;
  const graph = createTestDeps({
    ...(options.localFileAccess === undefined ? {} : { localFileAccess: options.localFileAccess })
  });
  const rateLimiter = createMemoryRateLimiter();
  const logger = graph.logger;
  const metrics = graph.metrics;
  const auth = createAuthService({ config, env, tenants: tenantRecords, logger });
  const webhook = createWebhookHandler({
    repository: graph.repository,
    logger,
    metrics,
    nudge: (jobId) => graph.worker.nudge(jobId)
  });
  const http = await startHttpServer({
    config,
    deps: graph.deps,
    auth,
    logger,
    metrics,
    webhook,
    readiness: async () => ({ ok: true, checks: { repository: true } }),
    contextFor: (authContext: AuthContext, workspaceId?: string) => httpRequestContext(authContext, workspaceId)
  });
  const address = http.app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort;

  return {
    config,
    repository: graph.repository,
    registry: graph.registry,
    provider: graph.provider,
    media: graph.media,
    jobs: graph.jobs,
    generation: graph.generation,
    worker: graph.worker,
    rateLimiter,
    auth,
    logger,
    metrics,
    http,
    graph,
    url: `http://127.0.0.1:${port}`,
    tenant: (tenantId: string) => {
      const found = tenants.find((entry) => entry.tenantId === tenantId);
      if (found === undefined) throw new Error(`unknown test tenant ${tenantId}`);
      return found;
    },
    contextFor(tenantId: string): RequestContext {
      const tenant = tenants.find((entry) => entry.tenantId === tenantId);
      if (tenant === undefined) throw new Error(`unknown test tenant ${tenantId}`);
      return {
        requestId: `req_${tenantId}`,
        tenantId,
        transport: 'http',
        auth: { tenantId, mode: 'static_token', scopes: [...tenant.scopes], tokenId: tenant.tokenId }
      };
    },
    async close() {
      await http.close();
      await graph.repository.close();
      await rateLimiter.close();
    }
  };
}
