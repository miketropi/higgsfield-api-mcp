import { describe, expect, it } from 'vitest';
import { createRemoteFetcher, type RemoteFetcherOptions } from '../../../packages/core/src/media/remote-fetch.js';
import { createSilentLogger } from '../../fixtures/fakes.js';
import {
  binaryResponse,
  createFetchDouble,
  createResolverDouble,
  expectGatewayError,
  PNG_BYTES,
  PUBLIC_ADDRESS,
  TEXT_BYTES
} from './helpers.js';

const MAX_BYTES = 1024;

function build(overrides: Partial<RemoteFetcherOptions> = {}) {
  return createRemoteFetcher({
    maxBytes: MAX_BYTES,
    downloadTimeoutMs: 1_000,
    maxRedirects: 3,
    logger: createSilentLogger(),
    ...overrides
  });
}

function publicFetch(handler: Parameters<typeof createFetchDouble>[0]) {
  const resolver = createResolverDouble([PUBLIC_ADDRESS]);
  const fetch = createFetchDouble(handler);
  return { resolver, fetch, fetcher: build({ fetchImpl: fetch.fetchImpl, resolveHost: resolver.resolveHost }) };
}

describe('URL validation', () => {
  it.each([
    ['http://cdn.example.com/a.png', 'INVALID_INPUT'],
    ['https://user:pass@cdn.example.com/a.png', 'INVALID_INPUT'],
    ['https://127.0.0.1/a.png', 'INVALID_INPUT'],
    ['https://10.0.0.1/a.png', 'INVALID_INPUT'],
    ['https://169.254.169.254/latest/meta-data/', 'INVALID_INPUT'],
    ['https://[::1]/a.png', 'INVALID_INPUT'],
    ['https://[::ffff:127.0.0.1]/a.png', 'INVALID_INPUT'],
    ['https://localhost/a.png', 'INVALID_INPUT'],
    ['file:///etc/passwd', 'INVALID_INPUT']
  ])('rejects %s before any request', async (url, code) => {
    const { fetch, fetcher } = publicFetch(() => binaryResponse(PNG_BYTES));
    await expectGatewayError(fetcher.fetchMedia(url), code);
    expect(fetch.calls).toHaveLength(0);
  });

  it('rejects a hostname that resolves to a private address, without fetching', async () => {
    const resolver = createResolverDouble(['10.0.0.7']);
    const fetch = createFetchDouble(() => binaryResponse(PNG_BYTES));
    const fetcher = build({ fetchImpl: fetch.fetchImpl, resolveHost: resolver.resolveHost });

    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/a.png'), 'INVALID_INPUT');
    expect(fetch.calls).toHaveLength(0);
  });

  it('rejects when any address of a multi-address host is private', async () => {
    const resolver = createResolverDouble([PUBLIC_ADDRESS, '192.168.1.10']);
    const fetch = createFetchDouble(() => binaryResponse(PNG_BYTES));
    const fetcher = build({ fetchImpl: fetch.fetchImpl, resolveHost: resolver.resolveHost });

    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/a.png'), 'INVALID_INPUT');
    expect(fetch.calls).toHaveLength(0);
  });

  it('fails when the host cannot be resolved', async () => {
    const resolver = createResolverDouble(() => {
      throw new Error('ENOTFOUND');
    });
    const fetcher = build({ fetchImpl: createFetchDouble(() => binaryResponse(PNG_BYTES)).fetchImpl, resolveHost: resolver.resolveHost });
    await expectGatewayError(fetcher.fetchMedia('https://nope.example.com/a.png'), 'MEDIA_UPLOAD_FAILED');
  });
});

describe('redirects', () => {
  it('follows a redirect and re-resolves the new host', async () => {
    const resolver = createResolverDouble([PUBLIC_ADDRESS]);
    const fetch = createFetchDouble((url) =>
      url.includes('a.example') ? binaryResponse(PNG_BYTES, { status: 302, location: 'https://b.example/x.png' }) : binaryResponse(PNG_BYTES)
    );
    const fetcher = build({ fetchImpl: fetch.fetchImpl, resolveHost: resolver.resolveHost });

    const media = await fetcher.fetchMedia('https://a.example/a.png');
    expect(media.mimeType).toBe('image/png');
    expect(fetch.calls).toHaveLength(2);
    // One lookup per hop: the validated address is never re-resolved by the transport.
    expect(resolver.calls).toEqual(['a.example', 'b.example']);
  });

  it('rejects a redirect from a public host to a private one', async () => {
    const resolver = createResolverDouble((hostname) => (hostname === 'cdn.example.com' ? [PUBLIC_ADDRESS] : ['10.0.0.1']));
    const fetch = createFetchDouble(() => binaryResponse(PNG_BYTES, { status: 302, location: 'https://internal.example.com/x.png' }));
    const fetcher = build({ fetchImpl: fetch.fetchImpl, resolveHost: resolver.resolveHost });

    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/a.png'), 'INVALID_INPUT');
    expect(fetch.calls).toHaveLength(1);
  });

  it('rejects a redirect to a non-https scheme', async () => {
    const { fetcher } = publicFetch(() => binaryResponse(PNG_BYTES, { status: 302, location: 'http://cdn.example.com/x.png' }));
    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/a.png'), 'INVALID_INPUT');
  });

  it('rejects a redirect loop', async () => {
    const { fetcher } = publicFetch(() => binaryResponse(PNG_BYTES, { status: 302, location: 'https://cdn.example.com/a.png' }));
    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/a.png'), 'MEDIA_UPLOAD_FAILED');
  });

  it('rejects more hops than configured', async () => {
    let hop = 0;
    const { fetcher } = publicFetch(() => {
      hop += 1;
      return binaryResponse(PNG_BYTES, { status: 302, location: `https://cdn.example.com/hop-${hop}.png` });
    });
    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/start.png'), 'MEDIA_UPLOAD_FAILED');
  });

  it('rejects a redirect without a location', async () => {
    const { fetcher } = publicFetch(() => binaryResponse(PNG_BYTES, { status: 302 }));
    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/a.png'), 'MEDIA_UPLOAD_FAILED');
  });
});

describe('response validation', () => {
  it('returns validated bytes for a supported media type', async () => {
    const { fetch, fetcher } = publicFetch(() => binaryResponse(PNG_BYTES, { contentType: 'image/png' }));
    const media = await fetcher.fetchMedia('https://cdn.example.com/a.png');
    expect(media.mimeType).toBe('image/png');
    expect(media.mediaType).toBe('image');
    expect(media.bytes).toEqual(PNG_BYTES);
    expect(fetch.calls).toEqual(['https://cdn.example.com/a.png']);
  });

  it('rejects a body that exceeds the upload limit', async () => {
    const oversized = new Uint8Array(MAX_BYTES + 1);
    oversized.set(PNG_BYTES);
    const { fetcher } = publicFetch(() => binaryResponse(oversized));
    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/a.png'), 'INVALID_INPUT');
  });

  it('rejects a declared content length above the limit before reading', async () => {
    const { fetcher } = publicFetch(
      () => new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png', 'content-length': '999999' } })
    );
    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/a.png'), 'INVALID_INPUT');
  });

  it('rejects a body shorter than the declared content length', async () => {
    const { fetcher } = publicFetch(
      () =>
        new Response(PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(PNG_BYTES.byteLength + 10) }
        })
    );
    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/a.png'), 'MEDIA_UPLOAD_FAILED');
  });

  it('rejects content whose bytes are not a supported media type', async () => {
    const { fetcher } = publicFetch(() => binaryResponse(TEXT_BYTES, { contentType: 'image/png' }));
    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/fake.png'), 'INVALID_INPUT');
  });

  it('rejects an empty body', async () => {
    const { fetcher } = publicFetch(() => binaryResponse(new Uint8Array(), { status: 204 }));
    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/empty.png'), 'INVALID_INPUT');
  });

  it('allows non-upload types only under the result policy', async () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
    const resolver = createResolverDouble([PUBLIC_ADDRESS]);
    const fetch = createFetchDouble(() => binaryResponse(webm, { contentType: 'video/webm' }));
    const uploadPolicy = build({ fetchImpl: fetch.fetchImpl, resolveHost: resolver.resolveHost });
    const resultPolicy = build({ fetchImpl: fetch.fetchImpl, resolveHost: resolver.resolveHost, mimePolicy: 'result' });

    await expectGatewayError(uploadPolicy.fetchMedia('https://cdn.example.com/a.webm'), 'INVALID_INPUT');

    const media = await resultPolicy.fetchMedia('https://cdn.example.com/a.webm');
    expect(media.mimeType).toBe('video/webm');
    expect(media.mediaType).toBe('video');
  });

  it('maps a non-2xx response to a retryable failure', async () => {
    const { fetcher } = publicFetch(() => binaryResponse(TEXT_BYTES, { status: 500 }));
    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/a.png'), 'MEDIA_UPLOAD_FAILED');
  });

  it('maps a transport abort to TIMEOUT', async () => {
    const resolver = createResolverDouble([PUBLIC_ADDRESS]);
    const fetch = createFetchDouble(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })
    );
    const fetcher = build({ fetchImpl: fetch.fetchImpl, resolveHost: resolver.resolveHost, downloadTimeoutMs: 20 });
    await expectGatewayError(fetcher.fetchMedia('https://cdn.example.com/slow.png'), 'TIMEOUT');
  });
});
