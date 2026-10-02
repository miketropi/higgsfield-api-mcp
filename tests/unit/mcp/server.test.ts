import { describe, expect, it } from 'vitest';
import type {
  GenerationJob,
  GenerationResult,
  RequestContext,
  StructuredError
} from '@higgsfield-mcp/core';
import { GatewayError, createModelRegistry } from '@higgsfield-mcp/core';
import { createModelDiscovery } from '@higgsfield-mcp/provider-higgsfield';
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
import { TEST_CATALOG, createSilentLogger, createNullMetrics } from '../../fixtures/fakes.js';
import { createDocsFixture } from '../../fixtures/docs-directory.js';
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

/** Structured payload of a tool result, falling back to its JSON text content. */
function body(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? JSON.parse(textOf(result))) as Record<string, unknown>;
}

interface WireModelSummary {
  id: string;
  type: string;
  endpoint: string | null;
  capabilities: string[];
  schema_status: string;
  execution: { supported: boolean; reason?: string };
  availability: string;
  account_access: string;
}

function modelsOf(result: CallToolResult): { models: WireModelSummary[]; catalog: Record<string, unknown> } {
  const parsed = body(result) as unknown as { models: WireModelSummary[]; catalog: Record<string, unknown> };
  return parsed;
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
  tools: { names: [...TOOL_NAMES] },
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
  const registry = createModelRegistry({ models: TEST_CATALOG });
  const discovery = createModelDiscovery({
    manifest: registry,
    fetch: createDocsFixture({ manifest: TEST_CATALOG }).fetch,
    clock: { now: () => new Date() }
  });
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
    models: registry,
    discovery,
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
    expect(wire['tools']).toEqual({ count: TOOL_NAMES.length, names: [...TOOL_NAMES] });
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

  it('registers every frozen tool name and publishes the identical surface in capabilities', async () => {
    const { client, handler } = await connect(deps(), contextFor(['higgsfield:read', 'higgsfield:generate']));
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());

    const capabilities = body(await client.callTool({ name: 'higgsfield.capabilities', arguments: {} })) as unknown as {
      tools: { count: number; names: string[] };
    };
    expect(capabilities.tools.names.slice().sort()).toEqual(tools.tools.map((tool) => tool.name).sort());
    expect(capabilities.tools.count).toBe(tools.tools.length);
    await client.close();
    await handler.close();
  });

  it('reports documented models, execution support and the snapshot metadata without generating', async () => {
    let submissions = 0;
    const { client, handler } = await connect(
      deps({
        generation: {
          async submit(): Promise<GenerationResult> {
            submissions += 1;
            return JOB;
          }
        }
      }),
      contextFor(['higgsfield:read', 'higgsfield:generate'])
    );

    const all = modelsOf(await client.callTool({ name: 'higgsfield.models.list', arguments: {} }));
    expect(all.catalog).toMatchObject({ source: 'official_documentation', stale: false });
    expect(all.catalog['total']).toBe(all.models.length);
    expect(all.catalog['returned']).toBe(all.models.length);
    expect(all.models.map((model) => model.id)).toContain('alibaba/qwen-image-3/text-to-image');
    expect(all.models.find((model) => model.id === 'xai/grok-imagine-image-2.0')).toMatchObject({
      availability: 'documented',
      account_access: 'unverified',
      schema_status: 'available',
      execution: { supported: true }
    });

    const filtered = modelsOf(
      await client.callTool({
        name: 'higgsfield.models.list',
        arguments: { type: 'image', execution_supported: false }
      })
    );
    expect(filtered.models.length).toBeGreaterThan(0);
    for (const model of filtered.models) {
      expect(model.type).toBe('image');
      expect(model.execution.supported).toBe(false);
    }
    expect(filtered.catalog['returned']).toBe(filtered.models.length);
    expect(filtered.catalog['total']).toBeGreaterThan(filtered.models.length);

    const one = await client.callTool({ name: 'higgsfield.models.get', arguments: { model: 'xai/grok-imagine-image-2.0' } });
    const detail = body(one);
    expect(detail['id']).toBe('xai/grok-imagine-image-2.0');
    expect(detail['execution']).toEqual({ supported: true });
    expect(detail['catalog']).toMatchObject({ source: 'official_documentation' });
    expect(typeof detail['source']).toBe('object');

    const missing = await client.callTool({ name: 'higgsfield.models.get', arguments: { model: 'does/not/exist' } });
    expect(missing.isError).toBe(true);
    expect(body(missing)['error']).toMatchObject({ code: 'MODEL_NOT_FOUND' });

    // Discovery is read-only: none of the above may have submitted a generation.
    expect(submissions).toBe(0);
    await client.close();
    await handler.close();
  });

  it('serves the tool and resource surfaces from one catalog snapshot', async () => {
    const { client, handler } = await connect(deps(), contextFor(['higgsfield:read']));
    const listed = modelsOf(await client.callTool({ name: 'higgsfield.models.list', arguments: {} }));

    const resource = await client.readResource({ uri: RESOURCE_URIS.models });
    const resourceBody = JSON.parse((resource.contents[0] as { text: string }).text) as {
      models: WireModelSummary[];
      catalog: Record<string, unknown>;
    };
    expect(resourceBody.catalog['fetched_at']).toBe(listed.catalog['fetched_at']);
    expect(resourceBody.models.map((model) => model.id)).toEqual(listed.models.map((model) => model.id));

    const single = await client.readResource({ uri: 'higgsfield://models/xai/grok-imagine-image-2.0' });
    const singleBody = JSON.parse((single.contents[0] as { text: string }).text) as Record<string, unknown>;
    expect(singleBody['id']).toBe('xai/grok-imagine-image-2.0');
    expect((singleBody['catalog'] as Record<string, unknown>)['fetched_at']).toBe(listed.catalog['fetched_at']);
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
    // Model ids contain slashes, so the template must use reserved expansion.
    expect(RESOURCE_URIS.modelTemplate).toBe('higgsfield://models/{+id}');
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
