/**
 * Contract tests for `HiggsfieldProvider`: plan freeze/replay, documented
 * defaults, the two provider lifecycles, cancellation semantics, the signed
 * upload flow, cost estimation and handle safety.
 *
 * Everything runs against a local `node:http` double: no real network, no paid
 * calls, no environment mutation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  HiggsfieldProvider,
  createHiggsfieldProviderFactory,
  parseProviderJobHandle
} from '@higgsfield-mcp/provider-higgsfield';
import type { HiggsfieldFetch, ProviderJobHandle } from '@higgsfield-mcp/provider-higgsfield';
import { canonicalJson } from '@higgsfield-mcp/core';
import type {
  ProviderCredentials,
  ProviderGenerationRequest,
  ProviderJobSnapshot,
  ProviderSubmissionPlan
} from '@higgsfield-mcp/core';
import { ProviderDouble, headersNamed } from './support/provider-double.js';
import type { Stub } from './support/provider-double.js';

const CREDENTIALS: ProviderCredentials = {
  credentials: 'Key live-id:live-secret',
  accountId: 'acct-live-1'
};

const REQUEST_ID = 'd7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff';

const doubles: ProviderDouble[] = [];

async function startDouble(...stubs: Stub[]): Promise<ProviderDouble> {
  const double = await ProviderDouble.start(...stubs);
  doubles.push(double);
  return double;
}

function makeProvider(double: ProviderDouble): HiggsfieldProvider {
  return new HiggsfieldProvider({ credentials: CREDENTIALS, baseUrl: double.baseUrl });
}

/** A provider whose HTTP client is never exercised: used by the pure `prepare` tests. */
function pureProvider(): HiggsfieldProvider {
  return new HiggsfieldProvider({ credentials: CREDENTIALS, baseUrl: 'https://api.higgsfield.ai' });
}

function klingRequest(overrides: Partial<ProviderGenerationRequest> = {}): ProviderGenerationRequest {
  return {
    endpoint: 'kling-video/v2.5-turbo/pro/image-to-video',
    input: { prompt: 'a cat surfing', image_url: 'https://cdn.example.com/cat.png' },
    upstreamIdempotencyKey: 'idem-key-1',
    jobKind: 'generation',
    ...overrides
  };
}

function soulRequest(overrides: Partial<ProviderGenerationRequest> = {}): ProviderGenerationRequest {
  return {
    endpoint: 'soul-id',
    input: {
      name: 'hero',
      input_images: [{ type: 'image_url', image_url: 'https://cdn.example.com/face.png' }]
    },
    upstreamIdempotencyKey: 'idem-soul-1',
    jobKind: 'custom_reference',
    ...overrides
  };
}

function acceptedGeneration(): Stub {
  return {
    status: 200,
    body: {
      status: 'queued',
      request_id: REQUEST_ID,
      status_url: `https://api.higgsfield.ai/requests/${REQUEST_ID}/status`,
      cancel_url: `https://api.higgsfield.ai/requests/${REQUEST_ID}/cancel`
    }
  };
}

afterEach(async () => {
  await Promise.all(doubles.splice(0).map((double) => double.stop()));
});

describe('prepare', () => {
  it('is deterministic and applies the documented defaults', () => {
    const provider = pureProvider();
    const request = klingRequest();

    const first = provider.prepare(request);
    const second = provider.prepare(request);

    expect(canonicalJson(second.body)).toBe(canonicalJson(first.body));
    expect(second.bodyHash).toBe(first.bodyHash);
    expect(first.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.body).toEqual({
      prompt: 'a cat surfing',
      image_url: 'https://cdn.example.com/cat.png',
      duration: 5,
      cfg_scale: 0.5,
      negative_prompt: ''
    });
    // Byte-level key order is what the client puts on the wire, not object order.
    expect(canonicalJson(first.body)).toBe(
      '{"cfg_scale":0.5,"duration":5,"image_url":"https://cdn.example.com/cat.png","negative_prompt":"","prompt":"a cat surfing"}'
    );
    expect(first.endpoint).toBe('kling-video/v2.5-turbo/pro/image-to-video');
    expect(first.jobKind).toBe('generation');
  });

  it('does not override caller-supplied values with defaults', () => {
    const provider = pureProvider();
    const plan = provider.prepare(
      klingRequest({ input: { prompt: 'x', image_url: 'https://cdn.example.com/a.png', duration: 10 } })
    );
    expect(plan.body['duration']).toBe(10);
  });

  it('moves the documented webhook out of the body and into the query', () => {
    const provider = pureProvider();
    const plan = provider.prepare(
      klingRequest({ webhook: { url: 'https://hooks.example.com/higgsfield?token=abc' } })
    );

    expect(plan.query).toEqual({ hf_webhook: 'https://hooks.example.com/higgsfield?token=abc' });
    expect(plan.webhook).toEqual({ url: 'https://hooks.example.com/higgsfield?token=abc' });
    expect(Object.hasOwn(plan.body, 'hf_webhook')).toBe(false);
    expect(Object.hasOwn(plan.body, 'webhook')).toBe(false);
  });

  it('rejects a non-https webhook URL', () => {
    const provider = pureProvider();
    expect(() => provider.prepare(klingRequest({ webhook: { url: 'http://hooks.example.com/x' } }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  });

  it('rejects input that violates the endpoint schema before any network call', async () => {
    const double = await startDouble(acceptedGeneration());
    const provider = makeProvider(double);

    await expect(
      provider.generate(
        klingRequest({
          endpoint: 'bytedance/seedance-2.5/image-to-video',
          input: { image_url: 'https://cdn.example.com/a.png', not_a_field: true }
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(double.calls).toHaveLength(0);
  });

  it('requires a required documented field', async () => {
    const double = await startDouble(acceptedGeneration());
    const provider = makeProvider(double);

    await expect(
      provider.generate(
        klingRequest({ endpoint: 'bytedance/seedance-2.5/reference-to-video', input: { prompt: 'no references' } })
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(double.calls).toHaveLength(0);
  });

  it('rejects an unknown endpoint without any network call', async () => {
    const double = await startDouble(acceptedGeneration());
    const provider = makeProvider(double);

    await expect(provider.generate(klingRequest({ endpoint: 'not/a/model' }))).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND'
    });
    await expect(provider.generate(klingRequest({ endpoint: '../../etc/passwd' }))).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND'
    });
    expect(double.calls).toHaveLength(0);
  });

  it('rejects a job kind that does not match the resolved model lifecycle', () => {
    const provider = pureProvider();
    expect(() => provider.prepare(klingRequest({ jobKind: 'custom_reference' }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  });
});

describe('submit and generate', () => {
  it('posts the frozen body byte-identically, with the idempotency key verbatim', async () => {
    const double = await startDouble(acceptedGeneration(), acceptedGeneration());
    const provider = makeProvider(double);
    const plan = provider.prepare(klingRequest());
    // Simulates the gateway persisting the plan and reloading it later.
    const reloaded: ProviderSubmissionPlan = JSON.parse(JSON.stringify(plan));

    const first = await provider.submit(plan, { upstreamIdempotencyKey: 'idem-key-1' });
    const replay = await provider.submit(reloaded, { upstreamIdempotencyKey: 'idem-key-1' });

    expect(double.calls).toHaveLength(2);
    expect(double.calls[0]!.body.equals(double.calls[1]!.body)).toBe(true);
    expect(double.calls[0]!.body.toString('utf8')).toBe(canonicalJson(plan.body));
    expect(double.calls.map((call) => call.headers['idempotency-key'])).toEqual(['idem-key-1', 'idem-key-1']);
    expect(double.calls.map((call) => call.path)).toEqual([
      '/kling-video/v2.5-turbo/pro/image-to-video',
      '/kling-video/v2.5-turbo/pro/image-to-video'
    ]);
    expect(headersNamed(double.calls[0]!, 'authorization')).toEqual(['Key live-id:live-secret']);
    expect(first).toEqual(replay);
    expect(first.providerJobId).toBe(`generation:${REQUEST_ID}`);
    expect(first.status).toBe('queued');
    expect(first.assets).toEqual([]);
  });

  it('appends the frozen query parameters to the POST URL in sorted-key order', async () => {
    const double = await startDouble(acceptedGeneration());
    const provider = makeProvider(double);
    const plan = provider.prepare(
      klingRequest({ webhook: { url: 'https://hooks.example.com/hf?token=abc' } })
    );

    await provider.submit(plan, { upstreamIdempotencyKey: 'idem-key-1' });

    expect(double.calls[0]!.url).toBe(
      '/kling-video/v2.5-turbo/pro/image-to-video?hf_webhook=https%3A%2F%2Fhooks.example.com%2Fhf%3Ftoken%3Dabc'
    );
  });

  it('rejects a malformed persisted plan without any network call', async () => {
    const double = await startDouble(acceptedGeneration());
    const provider = makeProvider(double);
    const plan = provider.prepare(klingRequest());
    const tampered: ProviderSubmissionPlan = { ...plan, bodyHash: 'not-a-hash' };

    await expect(provider.submit(tampered, { upstreamIdempotencyKey: 'idem-key-1' })).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    });
    expect(double.calls).toHaveLength(0);
  });

  it('accepts the documented provider endpoint as the request endpoint for Soul', async () => {
    const double = await startDouble({
      status: 200,
      body: { id: 'ref-456', status: 'not_ready', fail_reason: null }
    });
    const provider = makeProvider(double);

    // The native router sends `v1/custom-references` (the documented provider
    // endpoint) for Soul while `RoutedRequest.endpoint` carries `model.id` for the
    // other six entries; both must resolve to the same registry entry.
    const snapshot = await provider.generate(soulRequest({ endpoint: 'v1/custom-references' }));

    expect(double.calls).toHaveLength(1);
    expect(double.calls[0]!.path).toBe('/v1/custom-references');
    expect(double.calls[0]!.headers['idempotency-key']).toBeUndefined();
    expect(snapshot.providerJobId).toBe('custom_reference:ref-456');
    expect(snapshot.status).toBe('queued');
  });

  it('routes custom references to the documented training endpoint with no idempotency key', async () => {
    const double = await startDouble({
      status: 200,
      body: {
        id: 'ref-123',
        name: 'hero',
        model_version: 'v2',
        status: 'queued',
        thumbnail_url: null,
        created_at: '2026-10-02T00:00:00Z',
        in_progress_at: null,
        fail_reason: null
      }
    });
    const provider = makeProvider(double);

    const snapshot = await provider.generate(soulRequest());

    expect(double.calls).toHaveLength(1);
    const call = double.calls[0]!;
    expect(call.path).toBe('/v1/custom-references');
    // Soul ID training is not documented as honouring Idempotency-Key.
    expect(call.headers['idempotency-key']).toBeUndefined();
    expect(call.body.toString('utf8')).toBe(
      canonicalJson({
        name: 'hero',
        model_version: 'v1',
        input_images: [{ type: 'image_url', image_url: 'https://cdn.example.com/face.png' }]
      })
    );
    expect(snapshot.providerJobId).toBe('custom_reference:ref-123');
    expect(snapshot.status).toBe('queued');
    expect(snapshot.metadata).toMatchObject({ custom_reference_id: 'ref-123', model_version: 'v2' });
  });
});

describe('getJob', () => {
  it.each([
    ['queued', 'queued'],
    ['in_progress', 'processing'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['nsfw', 'failed'],
    ['canceled', 'cancelled']
  ] as Array<[string, string]>)('maps the documented status %s to %s', async (raw, expected) => {
    const double = await startDouble({ status: 200, body: { status: raw, request_id: REQUEST_ID } });
    const provider = makeProvider(double);

    const snapshot = await provider.getJob(`generation:${REQUEST_ID}`);

    expect(snapshot.status).toBe(expected);
    expect(snapshot.providerJobId).toBe(`generation:${REQUEST_ID}`);
    expect(double.calls[0]!.path).toBe(`/requests/${REQUEST_ID}/status`);
    expect(double.calls[0]!.headers['idempotency-key']).toBeUndefined();
  });

  it('keeps an undocumented status non-terminal and records it', async () => {
    const double = await startDouble({ status: 200, body: { status: 'queued_v2', request_id: REQUEST_ID } });
    const provider = makeProvider(double);

    const snapshot = await provider.getJob(`generation:${REQUEST_ID}`);

    expect(snapshot.status).toBe('processing');
    expect(['completed', 'failed', 'cancelled']).not.toContain(snapshot.status);
    expect(snapshot.metadata).toMatchObject({ provider_status: 'queued_v2' });
  });

  it('flattens documented output fields into de-duplicated asset references', async () => {
    const double = await startDouble({
      status: 200,
      body: {
        status: 'completed',
        request_id: REQUEST_ID,
        images: [{ url: 'https://cdn.example.com/one.png' }, { url: 'https://cdn.example.com/two.png' }],
        video: { url: 'https://cdn.example.com/out.mp4' },
        audio: { url: 'https://cdn.example.com/out.mp3' },
        audios: [{ url: 'https://cdn.example.com/out.mp3' }]
      }
    });
    const provider = makeProvider(double);

    const snapshot = await provider.getJob(`generation:${REQUEST_ID}`);

    expect(snapshot.assets).toEqual([
      { url: 'https://cdn.example.com/one.png', mediaType: 'image' },
      { url: 'https://cdn.example.com/two.png', mediaType: 'image' },
      { url: 'https://cdn.example.com/out.mp4', mediaType: 'video' },
      { url: 'https://cdn.example.com/out.mp3', mediaType: 'audio' }
    ]);
  });

  it('ignores unusable asset URLs instead of failing the poll', async () => {
    const double = await startDouble({
      status: 200,
      body: {
        status: 'completed',
        request_id: REQUEST_ID,
        images: [{ url: 'javascript:alert(1)' }, { url: 'https://cdn.example.com/ok.png' }, {}]
      }
    });
    const provider = makeProvider(double);

    const snapshot = await provider.getJob(`generation:${REQUEST_ID}`);

    expect(snapshot.assets).toEqual([{ url: 'https://cdn.example.com/ok.png', mediaType: 'image' }]);
  });

  it('maps terminal provider failures onto structured errors', async () => {
    const double = await startDouble(
      { status: 200, body: { status: 'failed', request_id: REQUEST_ID, error: 'Generation failed' } },
      { status: 200, body: { status: 'nsfw', request_id: REQUEST_ID, error: null } }
    );
    const provider = makeProvider(double);

    const failed = await provider.getJob(`generation:${REQUEST_ID}`);
    const moderated = await provider.getJob(`generation:${REQUEST_ID}`);

    expect(failed.error).toMatchObject({ code: 'JOB_FAILED', message: 'Generation failed' });
    expect(moderated.error).toMatchObject({ code: 'POLICY_REJECTED' });
  });

  it('never follows the provider-supplied status_url', async () => {
    const double = await startDouble({
      status: 200,
      body: {
        status: 'in_progress',
        request_id: REQUEST_ID,
        status_url: 'https://evil.example/requests/other/status',
        cancel_url: 'https://evil.example/requests/other/cancel'
      }
    });
    const provider = makeProvider(double);

    await provider.getJob(`generation:${REQUEST_ID}`);

    expect(double.calls).toHaveLength(1);
    expect(double.calls[0]!.path).toBe(`/requests/${REQUEST_ID}/status`);
  });

  it('polls the custom reference lifecycle for custom_reference handles', async () => {
    const double = await startDouble({
      status: 200,
      body: {
        id: 'ref-9',
        status: 'completed',
        thumbnail_url: 'https://cdn.example.com/thumb.png',
        fail_reason: null
      }
    });
    const provider = makeProvider(double);

    const snapshot = await provider.getJob('custom_reference:ref-9');

    expect(double.calls[0]!.path).toBe('/v1/custom-references/ref-9');
    expect(snapshot.status).toBe('completed');
    expect(snapshot.assets).toEqual([{ url: 'https://cdn.example.com/thumb.png', mediaType: 'image' }]);
    expect(snapshot.metadata).toMatchObject({ custom_reference_id: 'ref-9' });
  });

  it('reports a failed custom reference with JOB_FAILED', async () => {
    const double = await startDouble({
      status: 200,
      body: { id: 'ref-9', status: 'failed', fail_reason: 'too few usable images' }
    });
    const provider = makeProvider(double);

    const snapshot = await provider.getJob('custom_reference:ref-9');

    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toMatchObject({ code: 'JOB_FAILED', message: 'too few usable images' });
  });

  it('attaches a provider-returned custom_reference_id to generation metadata', async () => {
    const double = await startDouble({
      status: 200,
      body: { status: 'in_progress', request_id: REQUEST_ID, custom_reference_id: 'ref-77' }
    });
    const provider = makeProvider(double);

    const snapshot = await provider.getJob(`generation:${REQUEST_ID}`);

    expect(snapshot.metadata).toMatchObject({ custom_reference_id: 'ref-77', provider_status: 'in_progress' });
  });

  it('rejects unsafe handles without any network call', async () => {
    const double = await startDouble({ status: 200, body: {} });
    const provider = makeProvider(double);

    const unsafe = [
      '../../etc/passwd',
      'generation:a/b',
      'generation:..',
      'https://evil.example/x',
      'generation:',
      'custom_reference:../../etc/passwd',
      'unknown:abc',
      ''
    ];
    for (const handle of unsafe) {
      await expect(provider.getJob(handle)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(provider.cancelJob(handle)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(double.calls).toHaveLength(0);
  });
});

describe('cancelJob', () => {
  it('accepts a documented 202 cancellation', async () => {
    const double = await startDouble({ status: 202, body: '' });
    const provider = makeProvider(double);

    await expect(provider.cancelJob(`generation:${REQUEST_ID}`)).resolves.toEqual({ accepted: true });
    expect(double.calls[0]!.path).toBe(`/requests/${REQUEST_ID}/cancel`);
    expect(double.calls[0]!.method).toBe('POST');
    expect(double.calls[0]!.body).toHaveLength(0);
  });

  it('reports processing_started with a snapshot for the documented 400 rejection', async () => {
    const double = await startDouble(
      { status: 400, body: { detail: 'The request has already started and can no longer be canceled.' } },
      { status: 200, body: { status: 'in_progress', request_id: REQUEST_ID } }
    );
    const provider = makeProvider(double);

    const outcome = await provider.cancelJob(`generation:${REQUEST_ID}`);

    expect(outcome).toMatchObject({ accepted: false, reason: 'processing_started' });
    const snapshot: ProviderJobSnapshot | undefined = 'snapshot' in outcome ? outcome.snapshot : undefined;
    expect(snapshot?.status).toBe('processing');
    expect(double.calls.map((call) => call.path)).toEqual([
      `/requests/${REQUEST_ID}/cancel`,
      `/requests/${REQUEST_ID}/status`
    ]);
  });

  it('reports not_found for a provider 404 without inventing a snapshot', async () => {
    const double = await startDouble({ status: 404, body: { detail: 'Request not found' } });
    const provider = makeProvider(double);

    await expect(provider.cancelJob(`generation:${REQUEST_ID}`)).resolves.toEqual({
      accepted: false,
      reason: 'not_found'
    });
    expect(double.calls).toHaveLength(1);
  });

  it('never attempts to cancel a custom reference', async () => {
    const double = await startDouble({ status: 202, body: '' });
    const provider = makeProvider(double);

    await expect(provider.cancelJob('custom_reference:ref-9')).resolves.toEqual({
      accepted: false,
      reason: 'unsupported'
    });
    expect(double.calls).toHaveLength(0);
  });
});

describe('uploadMedia', () => {
  it('creates a signed upload, then forwards every returned header with no provider credentials', async () => {
    const double = await startDouble();
    double.stub(
      {
        status: 200,
        body: {
          public_url: 'https://cdn.example.com/input/example.png',
          upload_url: `${double.baseUrl}/presigned?sig=abc&x-amz-tagging=retention%3Dtemporary`,
          content_type: 'image/png',
          upload_headers: { 'Content-Type': 'image/png', 'x-amz-tagging': 'retention=temporary' }
        }
      },
      { status: 200, body: '' }
    );
    const provider = makeProvider(double);

    const upload = await provider.uploadMedia({
      bytes: new Uint8Array([9, 8, 7]),
      filename: 'example.png',
      mimeType: 'image/png',
      mediaType: 'image'
    });

    expect(double.calls).toHaveLength(2);
    const created = double.calls[0]!;
    expect(created.path).toBe('/files/generate-upload-url');
    expect(created.body.toString('utf8')).toBe('{"content_type":"image/png"}');
    expect(headersNamed(created, 'authorization')).toEqual(['Key live-id:live-secret']);

    const put = double.calls[1]!;
    expect(put.method).toBe('PUT');
    expect(put.path).toBe('/presigned');
    expect(put.query['sig']).toBe('abc');
    expect(headersNamed(put, 'authorization')).toEqual([]);
    expect(put.headers['content-type']).toBe('image/png');
    expect(put.headers['x-amz-tagging']).toBe('retention=temporary');
    expect([...put.body]).toEqual([9, 8, 7]);

    expect(upload).toMatchObject({
      url: 'https://cdn.example.com/input/example.png',
      provider: 'higgsfield',
      mediaType: 'image',
      mimeType: 'image/png',
      size: 3
    });
    expect(Date.parse(upload.expiresAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('rejects a content type the provider does not document, without any network call', async () => {
    const double = await startDouble({ status: 200, body: {} });
    const provider = makeProvider(double);

    await expect(
      provider.uploadMedia({
        bytes: new Uint8Array([1]),
        filename: 'clip.mov',
        mimeType: 'video/quicktime',
        mediaType: 'video'
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(double.calls).toHaveLength(0);
  });

  it('fails the upload when the ticket content type is not a documented type', async () => {
    const double = await startDouble({
      status: 200,
      body: {
        public_url: 'https://cdn.example.com/input/example.png',
        upload_url: 'https://storage.example.com/presigned?sig=abc',
        content_type: 'application/x-msdownload',
        upload_headers: { 'Content-Type': 'application/x-msdownload' }
      }
    });
    const provider = makeProvider(double);

    await expect(
      provider.uploadMedia({
        bytes: new Uint8Array([1]),
        filename: 'example.png',
        mimeType: 'image/png',
        mediaType: 'image'
      })
    ).rejects.toMatchObject({ code: 'MEDIA_UPLOAD_FAILED' });
    expect(double.calls).toHaveLength(1);
  });

  it('accepts the provider normalizing a documented alias to its canonical type', async () => {
    const double = await startDouble();
    double.stub(
      {
        status: 200,
        body: {
          public_url: 'https://cdn.example.com/input/example.jpg',
          upload_url: `${double.baseUrl}/presigned?sig=abc`,
          content_type: 'image/jpeg',
          upload_headers: { 'Content-Type': 'image/jpeg' }
        }
      },
      { status: 200, body: '' }
    );
    const provider = makeProvider(double);

    const upload = await provider.uploadMedia({
      bytes: new Uint8Array([1]),
      filename: 'example.jpg',
      mimeType: 'image/jpg',
      mediaType: 'image'
    });

    expect(upload.mimeType).toBe('image/jpeg');
    expect(double.calls[1]!.headers['content-type']).toBe('image/jpeg');
  });
});

describe('uploadMedia target policy', () => {
  const refusedTargets = [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1/presigned',
    'http://[::1]/presigned',
    'https://169.254.169.254/presigned',
    'https://127.0.0.1/presigned',
    'https://[::1]/presigned',
    'https://10.1.2.3/presigned',
    'https://[::ffff:127.0.0.1]/presigned',
    'https://0.0.0.0/presigned',
    'https://localhost/presigned'
  ];

  function ticketFetch(target: string, calls: Array<{ url: string; method: string }>): HiggsfieldFetch {
    return async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response(
        JSON.stringify({
          public_url: 'https://cdn.example.com/input/example.png',
          upload_url: target,
          content_type: 'image/png',
          upload_headers: { 'Content-Type': 'image/png' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
  }

  it.each(refusedTargets)('refuses the signed upload target %s without sending any bytes', async (target) => {
    const calls: Array<{ url: string; method: string }> = [];
    // Public provider origin: the production shape, where a hostile ticket or a
    // proxy must not be able to aim the PUT at an internal address.
    const provider = new HiggsfieldProvider({
      credentials: CREDENTIALS,
      baseUrl: 'https://api.higgsfield.ai',
      fetchImpl: ticketFetch(target, calls)
    });

    await expect(
      provider.uploadMedia({
        bytes: new Uint8Array([1, 2, 3]),
        filename: 'example.png',
        mimeType: 'image/png',
        mediaType: 'image'
      })
    ).rejects.toMatchObject({
      code: 'MEDIA_UPLOAD_FAILED',
      retryable: false,
      details: { reason: 'untrusted_upload_target' }
    });

    // Only the ticket POST happened: no PUT reached the refused address.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
  });

  it('still uploads when the ticket points at a public https host', async () => {
    const calls: string[] = [];
    const fetchImpl: HiggsfieldFetch = async (input, init) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${String(input)}`);
      if (method === 'PUT') return new Response('', { status: 200 });
      return new Response(
        JSON.stringify({
          public_url: 'https://cdn.example.com/input/example.png',
          upload_url: 'https://storage.example.com/presigned?sig=a',
          content_type: 'image/png',
          upload_headers: { 'Content-Type': 'image/png' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    const provider = new HiggsfieldProvider({
      credentials: CREDENTIALS,
      baseUrl: 'https://api.higgsfield.ai',
      fetchImpl
    });

    const upload = await provider.uploadMedia({
      bytes: new Uint8Array([1]),
      filename: 'example.png',
      mimeType: 'image/png',
      mediaType: 'image'
    });

    expect(upload.url).toBe('https://cdn.example.com/input/example.png');
    expect(calls).toEqual([
      'POST https://api.higgsfield.ai/files/generate-upload-url',
      'PUT https://storage.example.com/presigned?sig=a'
    ]);
  });

  it('pins an internal provider origin to its own origin, so a dev double keeps working', async () => {
    const double = await startDouble();
    double.stub(
      {
        status: 200,
        body: {
          public_url: 'https://cdn.example.com/input/example.png',
          upload_url: 'http://169.254.169.254/presigned',
          content_type: 'image/png',
          upload_headers: { 'Content-Type': 'image/png' }
        }
      }
    );
    const provider = makeProvider(double);

    await expect(
      provider.uploadMedia({
        bytes: new Uint8Array([1]),
        filename: 'example.png',
        mimeType: 'image/png',
        mediaType: 'image'
      })
    ).rejects.toMatchObject({ code: 'MEDIA_UPLOAD_FAILED', details: { reason: 'untrusted_upload_target' } });

    // The operator-configured internal origin is trusted, but nothing else is.
    expect(double.calls).toHaveLength(1);
    expect(double.calls[0]!.method).toBe('POST');
  });
});

describe('estimateCost and provider identity', () => {
  it('estimates through the documented endpoint and parses the decimal USD string', async () => {
    const double = await startDouble({ status: 200, body: { credits: '1.500', usd: '0.094' } });
    const provider = makeProvider(double);

    const estimate = await provider.estimateCost({
      endpoint: 'kling-video/v2.5-turbo/pro/text-to-video',
      input: { prompt: 'a cat' }
    });

    expect(estimate.microUsd).toBe(94000);
    expect(estimate).toMatchObject({
      currency: 'USD',
      source: 'estimate_api',
      endpoint: 'kling-video/v2.5-turbo/pro/text-to-video'
    });
    expect(double.calls[0]!.path).toBe('/estimate/kling-video/v2.5-turbo/pro/text-to-video');
    expect(double.calls[0]!.body.toString('utf8')).toBe(
      canonicalJson({ prompt: 'a cat', duration: 5, cfg_scale: 0.5, negative_prompt: '' })
    );
  });

  it('refuses an estimate for the custom-reference lifecycle', async () => {
    const double = await startDouble({ status: 200, body: { usd: '0.094' } });
    const provider = makeProvider(double);

    await expect(
      provider.estimateCost({ endpoint: 'soul-id', input: { name: 'hero', input_images: [] } })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(double.calls).toHaveLength(0);
  });

  it('reports the resolved account binding and the documented model catalog', async () => {
    const double = await startDouble({ status: 200, body: {} });
    const provider = makeProvider(double);

    expect(provider.id).toBe('higgsfield');
    expect(provider.version).toBe('0.1.0');
    expect(provider.accountId).toBe('acct-live-1');
    expect(provider.getIdempotencySupport()).toBe('documented');
    expect(provider.getIdempotencySupport('custom_reference')).toBe('unknown');
    await expect(provider.getModels()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'soul-id', kind: 'custom_reference' })])
    );
    await expect(provider.getModel('kling-video/v2.5-turbo/pro/text-to-video')).resolves.toMatchObject({
      concurrencyClass: 'video'
    });
    await expect(provider.getModel('nope')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    expect(double.calls).toHaveLength(0);
  });

  it('builds a provider per request context from the credential resolver', async () => {
    const double = await startDouble({ status: 200, body: {} });
    const factory = createHiggsfieldProviderFactory({
      credentialResolver: {
        resolve: async () => CREDENTIALS
      },
      baseUrl: double.baseUrl
    });

    const provider = await factory.forContext({ requestId: 'req-1', transport: 'stdio' });

    expect(factory.providerId).toBe('higgsfield');
    expect(provider.id).toBe('higgsfield');
    expect(provider.accountId).toBe('acct-live-1');
    expect(provider instanceof HiggsfieldProvider).toBe(true);
  });
});

describe('parseProviderJobHandle', () => {
  it('parses both documented handle families', () => {
    expect(parseProviderJobHandle(`generation:${REQUEST_ID}`)).toEqual({ kind: 'generation', id: REQUEST_ID });
    expect(parseProviderJobHandle('custom_reference:ref-1')).toEqual({ kind: 'custom_reference', id: 'ref-1' });
  });

  it('rejects every other shape', () => {
    for (const handle of ['../x', 'generation:a b', 'generation:a/b', 'http://x/y', 'soul-id']) {
      expect(() => parseProviderJobHandle(handle)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });

  it('narrows the parsed handle type for consumers', () => {
    const handle: ProviderJobHandle = parseProviderJobHandle('custom_reference:ref-1');
    expect(handle.kind).toBe('custom_reference');
  });
});
