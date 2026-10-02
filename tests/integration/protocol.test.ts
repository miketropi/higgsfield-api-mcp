import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { TEST_TOKEN, startTestGateway } from './harness/gateway.js';
import type { TestGateway } from './harness/gateway.js';
import { TOOL_NAMES } from '@higgsfield-mcp/mcp';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxBin = `${repoRoot}node_modules/.bin/tsx`;
const stdioEntry = `${repoRoot}tests/integration/fixtures/stdio-gateway.ts`;

async function stdioClient(mode: 'auto' | 'legacy'): Promise<Client> {
  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [stdioEntry],
    cwd: repoRoot,
    env: { ...process.env } as Record<string, string>
  });
  const client = new Client({ name: 'stdio-gate-verify', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return client;
}

describe('protocol gate', () => {
  let gateway: TestGateway;

  beforeAll(async () => {
    gateway = await startTestGateway();
  });

  afterAll(async () => {
    if (gateway !== undefined) await gateway.close();
  });

  it('serves the modern 2026-07-28 era over stdio with the full tool and resource surface', async () => {
    const client = await stdioClient('auto');
    expect(client.getProtocolEra()).toBe('modern');
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools.tools) {
      expect(tool.inputSchema?.type).toBe('object');
    }

    const listed = await client.listResources();
    expect(listed.resources.map((resource) => resource.uri)).toContain('higgsfield://models');

    const job = await client.callTool({ name: 'higgsfield.generate_image', arguments: { prompt: 'a lighthouse' } });
    expect(job.isError).toBeFalsy();
    const jobId = String((job.structuredContent as Record<string, unknown>)['job_id']);
    expect(jobId.startsWith('job_')).toBe(true);

    const waited = await client.callTool({ name: 'higgsfield.jobs.wait', arguments: { job_id: jobId, timeout_ms: 2_000 } });
    expect(waited.isError).toBeFalsy();
    expect((waited.structuredContent as Record<string, unknown>)['status']).toBe('queued');

    const capabilities = await client.callTool({ name: 'higgsfield.capabilities', arguments: {} });
    expect((capabilities.structuredContent as Record<string, unknown>)['mcp_protocol']).toBe('2026-07-28');
    await client.close();
  });

  it('serves a legacy stateless session over stdio with the same contract', async () => {
    const client = await stdioClient('legacy');
    expect(client.getProtocolEra()).toBe('legacy');
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(TOOL_NAMES.length);
    const result = await client.callTool({ name: 'higgsfield.models.list', arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it('serves modern and legacy clients over HTTP from the same deployment', async () => {
    const modern = new Client({ name: 'http-modern', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await modern.connect(
      new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`), {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set('authorization', `Bearer ${TEST_TOKEN}`);
          return fetch(input, { ...init, headers });
        }
      })
    );
    expect(modern.getProtocolEra()).toBe('modern');
    const modernTools = await modern.listTools();
    expect(modernTools.tools).toHaveLength(TOOL_NAMES.length);

    const legacy = new Client({ name: 'http-legacy', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await legacy.connect(
      new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`), {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set('authorization', `Bearer ${TEST_TOKEN}`);
          return fetch(input, { ...init, headers });
        }
      })
    );
    expect(legacy.getProtocolEra()).toBe('legacy');
    const legacyTools = await legacy.listTools();
    expect(legacyTools.tools).toHaveLength(TOOL_NAMES.length);

    const discovered = await modern.discover();
    expect(discovered).toBeTruthy();
    await modern.close();
    await legacy.close();
  });

  it('keeps dotted tool names stable across both eras and returns structured errors for domain failures', async () => {
    const client = await stdioClient('auto');
    const missing = await client.callTool({ name: 'higgsfield.jobs.get', arguments: { job_id: 'job_missing' } });
    expect(missing.isError).toBe(true);
    const body = JSON.parse(String((missing.content[0] as { text: string }).text)) as { error: { code: string } };
    expect(body.error.code).toBe('JOB_NOT_FOUND');

    // An unregistered tool name is a protocol-level failure, not a domain error.
    await expect(client.callTool({ name: 'higgsfield.does_not_exist', arguments: {} })).rejects.toThrow();
    await client.close();
  });
});
