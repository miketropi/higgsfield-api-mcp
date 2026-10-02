import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { EXPIRED_TOKEN, PUBLIC_URL, TEST_TOKEN, startTestGateway } from './harness/gateway.js';
import type { TestGateway } from './harness/gateway.js';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const json = { 'content-type': 'application/json' };

async function call(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { ...json, Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

/** Raw HTTP helper: `fetch` refuses to set a forbidden `Host` header, so rebinding tests need node:http. */
async function rawRequest(
  gateway: TestGateway,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const url = new URL(gateway.url);
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>();
  const request = httpRequest(
    {
      host: url.hostname,
      port: Number(url.port),
      method: options.method ?? 'POST',
      path: options.path ?? '/mcp',
      headers: { accept: 'application/json, text/event-stream', ...(options.headers ?? {}) }
    },
    (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') })
      );
    }
  );
  request.on('error', reject);
  if (options.body !== undefined) request.write(options.body);
  request.end();
  return promise;
}

async function mcpClient(gateway: TestGateway, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`), {
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    }
  });
  const client = new Client({ name: 'isolation-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return client;
}

function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? JSON.parse(String((result.content[0] as { text: string }).text))) as Record<
    string,
    unknown
  >;
}

function errorCode(result: CallToolResult): string {
  const parsed = JSON.parse(String((result.content[0] as { text: string }).text)) as { error?: { code?: string } };
  return parsed.error?.code ?? '(none)';
}

describe('isolation, abuse and secret-handling gate', () => {
  let gateway: TestGateway;

  beforeAll(async () => {
    gateway = await startTestGateway();
  });

  afterAll(async () => {
    if (gateway !== undefined) await gateway.close();
  });

  it('rejects a missing, unknown and expired bearer token before any MCP work', async () => {
    const anonymous = await call(gateway.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('resource_metadata');

    const unknown = await call(gateway.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer nope' });
    expect(unknown.status).toBe(401);

    const expired = await call(
      gateway.url,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { authorization: `Bearer ${EXPIRED_TOKEN}` }
    );
    expect(expired.status).toBe(401);
  });

  it('rejects an unapproved Origin and an unapproved Host', async () => {
    const badOrigin = await call(
      gateway.url,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { ...AUTH, origin: 'https://evil.example.com' }
    );
    expect(badOrigin.status).toBe(403);

    const badHost = await rawRequest(gateway, {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_TOKEN}`,
        host: 'attacker.example.com'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(badHost.status).toBe(403);

    const allowedHeaderCase = await rawRequest(gateway, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(allowedHeaderCase.status).toBe(200);
    expect(allowedHeaderCase.body).toContain('higgsfield.generate_image');
  });

  it('protects metrics with its own token and keeps health public without leaking configuration', async () => {
    const unauthorized = await fetch(`${gateway.url}/metrics`);
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(`${gateway.url}/metrics`, { headers: { authorization: 'Bearer metrics-token-0123456789' } });
    expect(authorized.status).toBe(200);

    const health = await fetch(`${gateway.url}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['status', 'version', 'uptime_s']);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('serves RFC 9728 protected-resource metadata for the configured public URL', async () => {
    const response = await fetch(`${gateway.url}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['resource']).toBe(PUBLIC_URL);
    expect(body['authorization_servers']).toBeUndefined();
  });

  it('bounds the request body and rejects an unregistered endpoint', async () => {
    const submitsBefore = gateway.provider.calls.filter((entry) => entry.kind === 'submit').length;
    const oversized = await rawRequest(gateway, {
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'higgsfield.generate_image', arguments: { prompt: 'x'.repeat(1_100_000) } }
      })
    }).catch(() => undefined);
    expect(oversized?.status ?? 413).toBe(413);
    expect(gateway.provider.calls.filter((entry) => entry.kind === 'submit').length).toBe(submitsBefore);

    const client = await mcpClient(gateway, TEST_TOKEN);
    const forbidden = await client.callTool({
      name: 'higgsfield.generate',
      arguments: { endpoint: 'https://evil.example.com/steal', input: { prompt: 'x' } }
    });
    expect(forbidden.isError).toBe(true);
    expect(errorCode(forbidden)).toBe('MODEL_NOT_FOUND');
    const traversal = await client.callTool({
      name: 'higgsfield.generate',
      arguments: { endpoint: '../../etc/passwd', input: { prompt: 'x' } }
    });
    expect(errorCode(traversal)).toBe('MODEL_NOT_FOUND');
    await client.close();
  });

  it('rejects private and malformed provider URLs and remote file paths', async () => {
    const client = await mcpClient(gateway, TEST_TOKEN);
    const privateUrl = await client.callTool({
      name: 'higgsfield.generate',
      arguments: {
        endpoint: 'kling-video/v2.5-turbo/pro/image-to-video',
        input: { prompt: 'x', image_url: 'http://169.254.169.254/latest/meta-data' }
      }
    });
    expect(privateUrl.isError).toBe(true);
    expect(errorCode(privateUrl)).toBe('INVALID_INPUT');

    const fileInput = await client.callTool({
      name: 'higgsfield.generate_image',
      arguments: { prompt: 'x', reference_images: [{ type: 'file', path: '/tmp/secret.png' }] }
    });
    expect(fileInput.isError).toBe(true);
    expect(errorCode(fileInput)).toBe('INVALID_INPUT');

    const remoteUpload = await client.callTool({
      name: 'higgsfield.media.upload',
      arguments: { source: { path: '/tmp/secret.png' } }
    });
    expect(remoteUpload.isError).toBe(true);
    expect(errorCode(remoteUpload)).toBe('INVALID_INPUT');
    await client.close();
  });

  it('keeps tenant jobs, assets and resources isolated', async () => {
    const tenantA = await mcpClient(gateway, TEST_TOKEN);
    const tenantB = await mcpClient(gateway, gateway.tenant('tenant-b').token);

    const submitted = await tenantA.callTool({ name: 'higgsfield.generate_image', arguments: { prompt: 'tenant a art' } });
    const jobId = String(structured(submitted)['job_id']);

    const foreignGet = await tenantB.callTool({ name: 'higgsfield.jobs.get', arguments: { job_id: jobId } });
    expect(foreignGet.isError).toBe(true);
    expect(errorCode(foreignGet)).toBe('JOB_NOT_FOUND');

    const foreignCancel = await tenantB.callTool({ name: 'higgsfield.jobs.cancel', arguments: { job_id: jobId } });
    expect(errorCode(foreignCancel)).toBe('JOB_NOT_FOUND');

    // A resource read for a foreign job is a JSON-RPC error; the message must not confirm ownership.
    await expect(tenantB.readResource({ uri: `higgsfield://jobs/${jobId}` })).rejects.toThrow(/not found/i);

    const sharedWorkspace = await tenantB.callTool({
      name: 'higgsfield.generate_image',
      arguments: { prompt: 'b art', workspace_id: 'campaign-42', wait: true }
    });
    const ownList = await tenantB.callTool({ name: 'higgsfield.jobs.list', arguments: {} });
    const ids = (structured(ownList)['jobs'] as Record<string, unknown>[]).map((job) => String(job['job_id']));
    expect(ids).toContain(String(structured(sharedWorkspace)['job_id']));
    expect(ids).not.toContain(jobId);

    const upload = await tenantA.callTool({
      name: 'higgsfield.media.upload',
      arguments: { source: { url: 'https://cdn.example.com/source.png' } }
    });
    expect(upload.isError).toBeFalsy();
    const ownAsset = await tenantA.callTool({ name: 'higgsfield.media.get', arguments: { asset_id: 'asset_uploaded' } });
    expect(ownAsset.isError).toBeFalsy();
    const foreignAsset = await tenantB.callTool({ name: 'higgsfield.media.get', arguments: { asset_id: 'asset_uploaded' } });
    expect(foreignAsset.isError).toBe(true);
    expect(errorCode(foreignAsset)).toBe('ACCESS_DENIED');

    await tenantA.close();
    await tenantB.close();
  });

  it('never leaks planted credential and signed-URL sentinels into results or logs', async () => {
    const sentinelCredential = 'Key sentinel-id:sentinel-secret-value';
    const sentinelSignature = 'X-Amz-Signature=planted-signature-sentinel';
    const client = await mcpClient(gateway, TEST_TOKEN);

    const failing = await client.callTool({
      name: 'higgsfield.generate',
      arguments: {
        endpoint: 'missing/endpoint',
        input: { prompt: sentinelCredential, image_url: `https://cdn.example.com/a.png?${sentinelSignature}` }
      }
    });
    const serialized = JSON.stringify(failing);
    expect(serialized).not.toContain('sentinel-secret-value');
    expect(serialized).not.toContain('planted-signature-sentinel');

    const logDump = JSON.stringify(gateway.logger.lines);
    expect(logDump).not.toContain('sentinel-secret-value');
    expect(logDump).not.toContain('planted-signature-sentinel');
    expect(logDump).not.toContain(TEST_TOKEN);
    await client.close();
  });

  it('collapses 20 concurrent identical requests into one logical job and one provider submission', async () => {
    const client = await mcpClient(gateway, TEST_TOKEN);
    const submitsBefore = gateway.provider.calls.filter((entry) => entry.kind === 'submit').length;
    const args = { prompt: 'concurrent campaign hero shot', idempotency_key: 'concurrent-key-1' };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => client.callTool({ name: 'higgsfield.generate_image', arguments: args }))
    );
    const jobIds = new Set(results.map((result) => String(structured(result)['job_id'])));
    expect(results.every((result) => result.isError !== true)).toBe(true);
    expect(jobIds.size).toBe(1);
    const jobId = [...jobIds][0] as string;

    // The same key with different normalized input is refused and submits nothing.
    const conflicting = await client.callTool({
      name: 'higgsfield.generate_image',
      arguments: { prompt: 'a different shot entirely', idempotency_key: 'concurrent-key-1' }
    });
    expect(conflicting.isError).toBe(true);
    expect(errorCode(conflicting)).toBe('INVALID_INPUT');

    // Drain the worker (earlier tests leave their own pending envelopes) until this job is submitted.
    for (let tick = 0; tick < 6; tick += 1) {
      await gateway.worker.runOnce();
      const envelope = await gateway.repository.transaction((tx) => tx.getSubmission('tenant-a', jobId));
      if (envelope?.state === 'acknowledged') break;
    }
    const submits = gateway.provider.calls.filter((entry) => entry.kind === 'submit');
    const matching = submits.filter((entry) => JSON.stringify(entry.body ?? {}).includes('concurrent campaign hero shot'));
    expect(matching).toHaveLength(1);
    const key = matching[0]?.upstreamIdempotencyKey;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(submits.filter((entry) => entry.upstreamIdempotencyKey === key)).toHaveLength(1);
    expect(submits.length).toBeGreaterThanOrEqual(submitsBefore);
    await client.close();
  });

  it('records no paid provider submission for a rejected request', async () => {
    const before = gateway.provider.calls.filter((entry) => entry.kind === 'submit').length;
    const client = await mcpClient(gateway, TEST_TOKEN);
    await client.callTool({
      name: 'higgsfield.generate',
      arguments: { endpoint: 'missing/endpoint', input: { prompt: 'x' } }
    });
    await client.callTool({ name: 'higgsfield.generate_image', arguments: { prompt: '' } });
    const after = gateway.provider.calls.filter((entry) => entry.kind === 'submit').length;
    expect(after).toBe(before);
    await client.close();
  });
});
