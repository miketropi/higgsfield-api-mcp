import { describe, expect, it } from 'vitest';
import type {
  GenerationJob,
  GenerationResult,
  RequestContext,
  StructuredError
} from '@higgsfield-mcp/core';
import { GatewayError } from '@higgsfield-mcp/core';
import {
  RESOURCE_URIS,
  TOOL_NAMES,
  createGatewayMcpServer,
  errorEnvelope,
  requireScope,
  serializeAsset,
  serializeCapabilities,
  serializeJob,
  toCoreInput
} from '@higgsfield-mcp/mcp';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { CallToolResult, McpHttpHandler } from '@modelcontextprotocol/server';
import { createSilentLogger, createNullMetrics } from '../../fixtures/fakes.js';
import type { McpToolDependencies } from '@higgsfield-mcp/mcp';

type Handler = McpHttpHandler;

/** In-process protocol harness: a real client talking to a real handler. */
async function connect(
  dependencies: McpToolDependencies,
  context: RequestContext
): Promise<{ client: Client; handler: Handler }> {
  const handler = createMcpHandler(() => createGatewayMcpServer(dependencies, context));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url: string | URL | Request, init?: RequestInit) => handler.fetch(new Request(url, init))
  });
  const client = new Client({ name: 'test-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return { client, handler };
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === 'text' ? first.text : '';
}

const JOB: GenerationJob = {
  id: 'job_abc',
  tenantId: 'tenant-a',
  provider: 'higgsfield',
  providerJobId: 'generation:1',
  capability: 'image_generation',
  model: 'xai/grok-imagine-image-2.0',
  endpoint: 'xai/grok-imagine-image-2.0',
  kind: 'generation',
  status: 'completed',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:10.000Z',
  inputSummary: { prompt: { length: 10 } },
  assets: [],
  cost: { currency: 'USD', estimatedMicroUsd: 94_000, actualMicroUsd: 88_000, source: 'estimate_api' },
  submissionState: 'acknowledged',
  tool: 'higgsfield.generate_image',
  concurrencyClass: 'image',
  workspaceId: 'campaign-42'
};

const CAPABILITIES = {
  gatewayVersion: '0.1.0',
  mcpProtocol: '2026-07-28',
  provider: { id: 'higgsfield', version: '0.1.0' },
  skillsVersion: '0.1.0+upstream.0.13.0',
  capabilities: ['image_generation'],
  auth: { mode: 'static_token' as const, scopes: ['higgsfield:read'] },
  limits: { maxWaitMs: 25_000, maxImageJobs: 10, maxVideoJobs: 3 }
};

function contextFor(scopes: string[]): RequestContext {
  return {
    requestId: 'req_test',
    tenantId: 'tenant-a',
    transport: 'http',
    auth: { tenantId: 'tenant-a', mode: 'static_token', scopes }
  };
}

function deps(overrides: Partial<McpToolDependencies> = {}): McpToolDependencies {
  const job = JOB;
  return {
    generation: {
      async submit(): Promise<GenerationResult> {
        return job;
      }
    },
    jobs: {
      async get() {
        return job;
      },
      async wait() {
        return job;
      },
      async cancel() {
        return job;
      },
      async list() {
        return { jobs: [job], nextCursor: 'cursor-1' };
      }
    },
    media: {
      async upload() {
        return {
          id: 'asset_1',
          tenantId: 'tenant-a',
          provider: 'higgsfield',
          mediaType: 'image',
          mimeType: 'image/png',
          url: 'https://cdn.example.com/a.png',
          createdAt: '2026-10-01T00:00:00.000Z',
          origin: 'upload',
          urlExpiresAt: '2026-10-01T00:15:00.000Z'
        };
      },
      async get() {
        return {
          id: 'asset_1',
          tenantId: 'tenant-a',
          provider: 'higgsfield',
          mediaType: 'image',
          mimeType: 'image/png',
          url: 'https://cdn.example.com/a.png',
          createdAt: '2026-10-01T00:00:00.000Z',
          origin: 'provider'
        };
      },
      async resolve(reference) {
        void reference;
        throw new GatewayError('INVALID_INPUT', 'not used');
      },
      async identify(reference) {
        void reference;
        throw new GatewayError('INVALID_INPUT', 'not used');
      }
    },
    models: {
      list() {
        return [];
      },
      get(id: string) {
        return {
          id,
          name: id,
          provider: 'higgsfield',
          type: 'image',
          endpoint: id,
          kind: 'generation',
          concurrencyClass: 'image',
          capabilities: ['image_generation'],
          status: 'active',
          limits: {},
          source: { url: 'https://docs.higgsfield.ai/', asOf: '2026-10-01' }
        };
      },
      resolve(id: string) {
        return this.get(id);
      },
      aliases() {
        return {};
      }
    },
    capabilities: CAPABILITIES,
    admission: { async admit() { return { allowed: true }; } },
    logger: createSilentLogger(),
    metrics: createNullMetrics(),
    ...overrides
  };
}

describe('MCP wire contract', () => {
  it('serializes a job without internal or credential fields and converts micro-USD to decimals', () => {
    const wire = serializeJob(JOB) as unknown as Record<string, unknown>;
    expect(wire['job_id']).toBe(JOB.id);
    expect(wire['workspace_id']).toBe('campaign-42');
    expect((wire['cost'] as Record<string, unknown>)['estimated_cost_usd']).toBe(0.094);
    expect((wire['cost'] as Record<string, unknown>)['actual_cost_usd']).toBe(0.088);
    const text = JSON.stringify(wire);
    for (const forbidden of ['tenant_id', 'submissionState', 'submission_state', 'storageKey', 'storage_key', 'origin', 'sha256']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('serializes an asset with the documented snake_case fields', () => {
    const wire = serializeAsset({
      id: 'asset_1',
      tenantId: 'tenant-a',
      provider: 'higgsfield',
      mediaType: 'video',
      mimeType: 'video/mp4',
      url: 'https://cdn.example.com/a.mp4',
      createdAt: '2026-10-01T00:00:00.000Z',
      durationSeconds: 5,
      origin: 'provider'
    }) as unknown as Record<string, unknown>;
    expect(wire).toMatchObject({ asset_id: 'asset_1', media_type: 'video', mime_type: 'video/mp4', duration_seconds: 5 });
    expect(wire['size']).toBeUndefined();
    expect(wire['origin']).toBeUndefined();
  });

  it('emits the structured error envelope with retry hints', () => {
    const envelope = errorEnvelope(new GatewayError('RATE_LIMITED', 'Too many requests.', { retryAfterMs: 1_234 })) as {
      error: StructuredError;
    };
    expect(envelope.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retry_after_ms: 1_234 });
  });

  it('publishes capabilities in snake_case', () => {
    const wire = serializeCapabilities(CAPABILITIES) as unknown as Record<string, unknown>;
    expect(wire['gateway_version']).toBe('0.1.0');
    expect((wire['limits'] as Record<string, unknown>)['max_wait_ms']).toBe(25_000);
  });

  it('converts asset_id wire references anywhere inside native input', () => {
    expect(toCoreInput({ image_urls: [{ type: 'asset', asset_id: 'asset_1' }] })).toEqual({
      image_urls: [{ type: 'asset', assetId: 'asset_1' }]
    });
    expect(toCoreInput({ prompt: 'x', nested: { refs: [{ type: 'url', url: 'https://x/y.png' }] } })).toEqual({
      prompt: 'x',
      nested: { refs: [{ type: 'url', url: 'https://x/y.png' }] }
    });
  });

  it('registers every frozen tool name over the real protocol and returns structured content', async () => {
    const { client, handler } = await connect(deps(), contextFor(['higgsfield:read', 'higgsfield:generate']));
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    const listed = await client.callTool({ name: 'higgsfield.models.list', arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect(listed.structuredContent).toEqual({ models: [] });
    await client.close();
    await handler.close();
  });

  it('denies a tool call whose credential lacks the required scope', async () => {
    const { client, handler } = await connect(deps(), contextFor(['higgsfield:read']));
    const result = await client.callTool({ name: 'higgsfield.generate_image', arguments: { prompt: 'a lighthouse' } });
    expect(result.isError).toBe(true);
    const body = JSON.parse(textOf(result)) as { error: StructuredError };
    expect(body.error.code).toBe('ACCESS_DENIED');
    await client.close();
    await handler.close();
  });

  it('returns the job for a generation call and surfaces confirmation_required untouched', async () => {
    const { client, handler } = await connect(deps(), contextFor(['higgsfield:read', 'higgsfield:generate']));
    const generated = await client.callTool({ name: 'higgsfield.generate_image', arguments: { prompt: 'a lighthouse', wait: true } });
    expect((generated.structuredContent as Record<string, unknown>)['job_id']).toBe('job_abc');
    await client.close();
    await handler.close();

    const confirming = await connect(
      deps({
        generation: {
          async submit(): Promise<GenerationResult> {
            return {
              status: 'confirmation_required',
              estimatedCostUsd: 8.4,
              confirmationToken: 'token',
              expiresAt: '2026-10-01T00:10:00.000Z'
            };
          }
        }
      }),
      contextFor(['higgsfield:generate'])
    );
    const confirmed = await confirming.client.callTool({ name: 'higgsfield.generate_video', arguments: { prompt: 'x' } });
    expect(confirmed.structuredContent).toEqual({
      status: 'confirmation_required',
      estimated_cost_usd: 8.4,
      confirmation_token: 'token',
      expires_at: '2026-10-01T00:10:00.000Z'
    });
    await confirming.client.close();
    await confirming.handler.close();
  });

  it('clamps jobs.wait to the gateway maximum and never cancels on timeout', async () => {
    let observed = -1;
    const { client, handler } = await connect(
      deps({
        jobs: {
          async get() {
            return JOB;
          },
          async wait(_id, timeoutMs) {
            observed = timeoutMs;
            return { ...JOB, status: 'processing' as const };
          },
          async cancel() {
            return JOB;
          },
          async list() {
            return { jobs: [] };
          }
        }
      }),
      contextFor(['higgsfield:read'])
    );
    const result = await client.callTool({ name: 'higgsfield.jobs.wait', arguments: { job_id: 'job_abc', timeout_ms: 600_000 } });
    expect(observed).toBe(25_000);
    expect((result.structuredContent as Record<string, unknown>)['status']).toBe('processing');
    await client.close();
    await handler.close();
  });

  it('exposes resources with the documented URIs and no tenant-private data', async () => {
    expect(RESOURCE_URIS.models).toBe('higgsfield://models');
    const { client, handler } = await connect(deps(), contextFor(['higgsfield:read']));
    const listed = await client.listResources();
    expect(listed.resources.map((resource) => resource.uri)).toContain(RESOURCE_URIS.capabilities);
    const capabilities = await client.readResource({ uri: RESOURCE_URIS.capabilities });
    const first = capabilities.contents[0] as { uri: string; text: string };
    expect(first.uri).toBe(RESOURCE_URIS.capabilities);
    expect(first.text).not.toContain('tenant-a');
    expect(JSON.parse(first.text)).toMatchObject({ gateway_version: '0.1.0' });

    const job = await client.readResource({ uri: 'higgsfield://jobs/job_abc' });
    expect(JSON.parse((job.contents[0] as { text: string }).text)).toMatchObject({ job_id: 'job_abc' });
    await client.close();
    await handler.close();
  });

  it('throws ACCESS_DENIED from requireScope for a scoped context and allows an unscoped stdio context', () => {
    expect(() => requireScope(contextFor(['higgsfield:read']), 'higgsfield:generate')).toThrow(GatewayError);
    expect(() =>
      requireScope({ requestId: 'req', tenantId: 'local', transport: 'stdio' }, 'higgsfield:generate')
    ).not.toThrow();
  });

  it('reports an invalid tool argument as an error result, never a protocol failure', async () => {
    const { client, handler } = await connect(deps(), contextFor(['higgsfield:generate']));
    const result = await client.callTool({ name: 'higgsfield.generate_image', arguments: { prompt: '' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('error');
    await client.close();
    await handler.close();
  });
});
