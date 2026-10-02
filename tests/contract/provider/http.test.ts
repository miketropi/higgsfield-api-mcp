/**
 * Contract tests for `HiggsfieldHttpClient`: credential handling, byte-exact
 * bodies, idempotency-key transport, redirect refusal, path safety, timeouts,
 * response caps and error translation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HiggsfieldHttpClient } from '@higgsfield-mcp/provider-higgsfield';
import type { HiggsfieldFetch, HiggsfieldHttpClientOptions } from '@higgsfield-mcp/provider-higgsfield';
import type { ProviderCredentials } from '@higgsfield-mcp/core';
import { ProviderDouble, headersNamed } from './support/provider-double.js';
import type { Stub } from './support/provider-double.js';

const CREDENTIALS: ProviderCredentials = {
  credentials: 'Key test-key-id:test-key-secret',
  accountId: 'acct-test-1'
};

const doubles: ProviderDouble[] = [];

/** Reads `.code` off an unknown rejection without a cast. */
function errorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function makeClient(baseUrl: string, overrides: Partial<HiggsfieldHttpClientOptions> = {}): HiggsfieldHttpClient {
  return new HiggsfieldHttpClient({ credentials: CREDENTIALS, baseUrl, ...overrides });
}

async function startDouble(...stubs: Stub[]): Promise<ProviderDouble> {
  const double = await ProviderDouble.start(...stubs);
  doubles.push(double);
  return double;
}

afterEach(async () => {
  await Promise.all(doubles.splice(0).map((double) => double.stop()));
});

describe('HiggsfieldHttpClient credentials', () => {
  it('sends the configured Authorization exactly once, with the exact configured value', async () => {
    const double = await startDouble({ status: 200, body: { ok: true } });
    const client = makeClient(double.baseUrl);

    await client.post('/v1/custom-references', { name: 'hero' });

    expect(double.calls).toHaveLength(1);
    const call = double.calls[0]!;
    expect(headersNamed(call, 'authorization')).toEqual(['Key test-key-id:test-key-secret']);
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('omits Authorization on the signed-URL PUT and forwards every returned upload header', async () => {
    const double = await startDouble({ status: 200, body: '' });
    const client = makeClient(double.baseUrl);

    await client.put(`${double.baseUrl}/signed/upload?X-Amz-Signature=secret`, new Uint8Array([1, 2, 3]), {
      'Content-Type': 'image/jpeg',
      'x-amz-tagging': 'retention=temporary'
    });

    const call = double.calls[0]!;
    expect(call.method).toBe('PUT');
    expect(headersNamed(call, 'authorization')).toEqual([]);
    expect(call.headers['content-type']).toBe('image/jpeg');
    expect(call.headers['x-amz-tagging']).toBe('retention=temporary');
    expect(call.query['X-Amz-Signature']).toBe('secret');
    expect([...call.body]).toEqual([1, 2, 3]);
  });

  it('refuses default headers that would duplicate the credential', () => {
    expect(
      () => new HiggsfieldHttpClient({ credentials: CREDENTIALS, defaultHeaders: { authorization: 'Bearer other' } })
    ).toThrowError(/Authorization/);
  });

  it('never puts the credential into an error message or its details', async () => {
    const double = await startDouble({ status: 401, body: { detail: 'Invalid credentials' } });
    const client = makeClient(double.baseUrl);

    const error = await client.post('/v1/custom-references', {}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(JSON.stringify(error)).not.toContain('test-key-secret');
  });
});

describe('HiggsfieldHttpClient request bodies', () => {
  it('serializes the body as canonical JSON, byte for byte', async () => {
    const double = await startDouble({ status: 200, body: {} });
    const client = makeClient(double.baseUrl);

    await client.post('/v1/custom-references', { z: 1, a: { d: 2, c: [3, { b: true }] } });

    expect(double.calls[0]!.body.toString('utf8')).toBe('{"a":{"c":[3,{"b":true}],"d":2},"z":1}');
  });

  it('sends Idempotency-Key verbatim when supplied and omits it otherwise', async () => {
    const double = await startDouble({ status: 200, body: {} }, { status: 200, body: {} });
    const client = makeClient(double.baseUrl);

    await client.post('/v1/custom-references', { name: 'a' }, { idempotencyKey: 'key-42' });
    await client.post('/v1/custom-references', { name: 'b' });

    expect(double.calls[0]!.headers['idempotency-key']).toBe('key-42');
    expect(double.calls[1]!.headers['idempotency-key']).toBeUndefined();
  });

  it('rejects a malformed idempotency key without any request', async () => {
    const double = await startDouble({ status: 200, body: {} });
    const client = makeClient(double.baseUrl);

    await expect(client.post('/v1/custom-references', {}, { idempotencyKey: 'has space' })).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    });
    expect(double.calls).toHaveLength(0);
  });

  it('serializes query parameters in sorted-key order', async () => {
    const double = await startDouble({ status: 200, body: {} });
    const client = makeClient(double.baseUrl);

    await client.post('/v1/custom-references', {}, { query: { z: '2', hf_webhook: 'https://hooks.example.com/a/b' } });

    expect(double.calls[0]!.url).toBe(
      '/v1/custom-references?hf_webhook=https%3A%2F%2Fhooks.example.com%2Fa%2Fb&z=2'
    );
  });

  it('sends no body and no Content-Type for the empty-body cancel call', async () => {
    const double = await startDouble({ status: 202, body: '' });
    const client = makeClient(double.baseUrl);

    await client.post('/requests/abc/cancel', undefined);

    expect(double.calls[0]!.body).toHaveLength(0);
    expect(double.calls[0]!.headers['content-type']).toBeUndefined();
  });
});

describe('HiggsfieldHttpClient boundaries', () => {
  it('refuses redirects instead of replaying the credential to another origin', async () => {
    const double = await startDouble({ status: 302, headers: { location: 'https://evil.example/collect' } });
    const client = makeClient(double.baseUrl);

    await expect(client.post('/v1/custom-references', {})).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(double.calls).toHaveLength(1);
  });

  it('rejects undocumented paths, traversal and absolute URLs without any request', async () => {
    const double = await startDouble({ status: 200, body: {} });
    const client = makeClient(double.baseUrl);

    const attempts = [
      () => client.get('/etc/passwd'),
      () => client.get('https://evil.example/steal'),
      () => client.get('/requests/..%2f..%2fetc/status'),
      () => client.get('/requests/a/status?x=1'),
      () => client.post('/requests/../../etc/cancel', undefined),
      () => client.post('/v1/custom-references/../../admin', {}),
      () => client.post('/etc/passwd', {}),
      () => client.get('/admin/keys'),
      () => client.get('/estimate/not-a-model'),
      () => client.post('/Kling-Video/Upper', {}),
      () => client.get('/requests')
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(double.calls).toHaveLength(0);
  });

  it('allows the documented model endpoint path and the documented estimate path', async () => {
    const double = await startDouble({ status: 200, body: {} }, { status: 200, body: { usd: '0.094' } });
    const client = makeClient(double.baseUrl);

    await client.post('/kling-video/v2.5-turbo/pro/text-to-video', { prompt: 'x' });
    await client.post('/estimate/kling-video/v2.5-turbo/pro/text-to-video', { prompt: 'x' });

    expect(double.calls.map((call) => call.path)).toEqual([
      '/kling-video/v2.5-turbo/pro/text-to-video',
      '/estimate/kling-video/v2.5-turbo/pro/text-to-video'
    ]);
  });

  it('refuses to PUT to an internal or plain-http address when the provider origin is public', async () => {
    let calls = 0;
    const fetchImpl: HiggsfieldFetch = async () => {
      calls += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new HiggsfieldHttpClient({
      credentials: CREDENTIALS,
      baseUrl: 'https://api.higgsfield.ai',
      fetchImpl
    });

    for (const target of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1/presigned',
      'http://[::1]/presigned',
      'https://127.0.0.1/presigned',
      'https://[::1]/presigned',
      'https://10.0.0.5/presigned',
      'https://[::ffff:127.0.0.1]/presigned',
      'https://localhost/presigned',
      'http://storage.example.com/presigned'
    ]) {
      await expect(client.put(target, new Uint8Array([1]), {})).rejects.toMatchObject({
        code: 'MEDIA_UPLOAD_FAILED',
        retryable: false,
        details: { reason: 'untrusted_upload_target' }
      });
    }
    expect(calls).toBe(0);
  });

  it('still PUTs to a public https target when the provider origin is public', async () => {
    let calls = 0;
    const fetchImpl: HiggsfieldFetch = async () => {
      calls += 1;
      return new Response('', { status: 200 });
    };
    const client = new HiggsfieldHttpClient({
      credentials: CREDENTIALS,
      baseUrl: 'https://api.higgsfield.ai',
      fetchImpl
    });

    await expect(
      client.put('https://storage.example.com/presigned?sig=a', new Uint8Array([1, 2]), { 'Content-Type': 'image/png' })
    ).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(1);
  });

  it('aborts a request when the caller signal is already aborted', async () => {
    const double = await startDouble({ status: 200, body: {} });
    const client = makeClient(double.baseUrl);
    const controller = new AbortController();
    controller.abort();

    await expect(client.get('/v1/custom-references', { signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED'
    });
    expect(double.calls).toHaveLength(0);
  });
});

describe('HiggsfieldHttpClient response handling', () => {
  it('uses the injected fetch implementation and caps the response body', async () => {
    let injected = 0;
    const fetchImpl: HiggsfieldFetch = async () => {
      injected += 1;
      return new Response('x'.repeat(4096), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new HiggsfieldHttpClient({
      credentials: CREDENTIALS,
      baseUrl: 'https://api.higgsfield.ai',
      fetchImpl,
      maxResponseBytes: 128
    });

    await expect(client.get('/v1/custom-references/ref-1')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(injected).toBe(1);
  });

  it('times out with TIMEOUT when the provider never answers', async () => {
    const fetchImpl: HiggsfieldFetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = new HiggsfieldHttpClient({
      credentials: CREDENTIALS,
      baseUrl: 'https://api.higgsfield.ai',
      fetchImpl,
      requestTimeoutMs: 20
    });

    await expect(client.get('/v1/custom-references/ref-1')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('translates documented provider failures onto canonical error codes', async () => {
    const double = await startDouble(
      { status: 401, body: { detail: 'Invalid credentials' } },
      { status: 403, body: { detail: 'Insufficient credits' } },
      { status: 400, body: { detail: 'Maximum number of concurrent requests (4) has been reached' } },
      { status: 400, body: { detail: 'prompt is required' } },
      { status: 422, body: { detail: 'Idempotency-Key was already used with different request parameters' } },
      { status: 423, body: { detail: 'Model is temporarily blocked' } },
      { status: 503, body: { detail: 'Model is disabled or not ready' } },
      { status: 500, body: { detail: 'Unexpected server error' } }
    );
    const client = makeClient(double.baseUrl);

    const codes: unknown[] = [];
    for (let index = 0; index < 8; index += 1) {
      const error = await client.post('/v1/custom-references', {}).catch((caught: unknown) => caught);
      codes.push(errorCode(error));
    }

    expect(codes).toEqual([
      'AUTHENTICATION_FAILED',
      'INSUFFICIENT_CREDITS',
      'RATE_LIMITED',
      'INVALID_INPUT',
      'INVALID_INPUT',
      'MODEL_UNAVAILABLE',
      'MODEL_UNAVAILABLE',
      'PROVIDER_ERROR'
    ]);
  });

  it('honours Retry-After when an edge publishes it', async () => {
    const double = await startDouble({ status: 429, headers: { 'retry-after': '2' }, body: { detail: 'slow down' } });
    const client = makeClient(double.baseUrl);

    const error = await client.post('/v1/custom-references', {}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 2000 });
  });

  it('returns null for an empty success body', async () => {
    const double = await startDouble({ status: 200, body: '' });
    const client = makeClient(double.baseUrl);

    await expect(client.post('/requests/abc/cancel', undefined)).resolves.toEqual({ status: 200, json: null });
  });
});
