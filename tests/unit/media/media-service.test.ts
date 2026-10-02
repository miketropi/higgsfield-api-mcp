import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MediaAsset, ProviderFactory } from '../../../packages/core/src/contracts.js';
import { GatewayError } from '../../../packages/core/src/errors.js';
import { createMemoryJobRepository } from '../../../packages/core/src/jobs/memory-repository.js';
import { createMediaService } from '../../../packages/core/src/media/service.js';
import { createFakeProvider, createNullMetrics, createSilentLogger, testContext } from '../../fixtures/fakes.js';
import {
  asset,
  binaryResponse,
  createClock,
  createFetchDouble,
  createHarness,
  createResolverDouble,
  DEFAULT_CONFIG,
  expectGatewayError,
  PNG_BYTES,
  PUBLIC_ADDRESS,
  seedAsset,
  TEXT_BYTES
} from './helpers.js';

const SOURCE_URL = 'https://cdn.example.com/input.png';

function harnessWithUrl(body: Uint8Array = PNG_BYTES, overrides: Parameters<typeof createHarness>[0] = {}) {
  const resolver = createResolverDouble([PUBLIC_ADDRESS]);
  const fetch = createFetchDouble(() => binaryResponse(body, { contentType: 'image/png' }));
  return {
    resolver,
    fetch,
    harness: createHarness({
      provider: createFakeProvider(),
      ...overrides,
      fetchImpl: fetch.fetchImpl,
      resolveHost: resolver.resolveHost
    })
  };
}

function tempFile(name: string, bytes: Uint8Array): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-media-service-'));
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}

describe('upload from a caller URL', () => {
  it('stores exactly one tenant-scoped asset and forwards the sniffed type', async () => {
    const { harness } = harnessWithUrl();
    const stored = await harness.service.upload({ source: { url: SOURCE_URL } }, testContext());

    expect(stored.origin).toBe('upload');
    expect(stored.tenantId).toBe('tenant-a');
    expect(stored.mimeType).toBe('image/png');
    expect(stored.mediaType).toBe('image');
    expect(stored.size).toBe(PNG_BYTES.byteLength);
    expect(stored.url).toBe('https://cdn.example.com/uploads/input.png');
    expect(harness.uploads).toHaveLength(1);
    expect(harness.uploads[0]?.mimeType).toBe('image/png');
    expect(harness.uploads[0]?.bytes).toEqual(PNG_BYTES);
    expect(harness.uploads[0]?.filename).toBe('input.png');

    const rows = await harness.repository.transaction(async (tx) => tx.listAssets('tenant-a', { limit: 10 }));
    expect(rows.assets).toHaveLength(1);
    expect(rows.assets[0]?.id).toBe(stored.id);
  });

  it('rejects a declared media type that contradicts the bytes', async () => {
    const { harness } = harnessWithUrl();
    await expectGatewayError(
      harness.service.upload({ source: { url: SOURCE_URL }, mediaType: 'video' }, testContext()),
      'INVALID_INPUT'
    );
    expect(harness.uploads).toHaveLength(0);
  });

  it('propagates a provider failure and writes no asset', async () => {
    const failing = {
      ...createFakeProvider(),
      uploadMedia: async (): Promise<never> => {
        throw new GatewayError('INSUFFICIENT_CREDITS', 'No credits.');
      }
    };
    const { harness } = harnessWithUrl(PNG_BYTES, { provider: failing });

    await expectGatewayError(harness.service.upload({ source: { url: SOURCE_URL } }, testContext()), 'INSUFFICIENT_CREDITS');
    const rows = await harness.repository.transaction(async (tx) => tx.listAssets('tenant-a', { limit: 10 }));
    expect(rows.assets).toHaveLength(0);
  });

  it('wraps an unexpected provider failure as a retryable upload failure', async () => {
    const failing = {
      ...createFakeProvider(),
      uploadMedia: async (): Promise<never> => {
        throw new Error('socket hang up');
      }
    };
    const { harness } = harnessWithUrl(PNG_BYTES, { provider: failing });

    const error = await expectGatewayError(
      harness.service.upload({ source: { url: SOURCE_URL } }, testContext()),
      'MEDIA_UPLOAD_FAILED'
    );
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain('socket hang up');
  });

  it('requires a resolved tenant', async () => {
    const { harness } = harnessWithUrl();
    await expectGatewayError(
      harness.service.upload({ source: { url: SOURCE_URL } }, { ...testContext(), tenantId: undefined }),
      'INTERNAL_ERROR'
    );
  });

  it('rejects a source that is neither a path nor a url', async () => {
    const { harness } = harnessWithUrl();
    await expectGatewayError(
      harness.service.upload({ source: {} } as unknown as { source: { url: string } }, testContext()),
      'INVALID_INPUT'
    );
  });
});

describe('asset reads', () => {
  it('resolves an asset reference for the owning tenant', async () => {
    const harness = createHarness();
    await seedAsset(harness.repository, asset({ id: 'asset_1', tenantId: 'tenant-a' }));
    const resolved = await harness.service.resolve({ type: 'asset', assetId: 'asset_1' }, testContext());
    expect(resolved.id).toBe('asset_1');
    expect(resolved.url).toBe('https://cdn.example.com/provider/asset.png');
  });

  it('denies a foreign asset instead of leaking its existence', async () => {
    const harness = createHarness();
    await seedAsset(harness.repository, asset({ id: 'asset_1', tenantId: 'tenant-b' }));
    await expectGatewayError(harness.service.resolve({ type: 'asset', assetId: 'asset_1' }, testContext('tenant-a')), 'ACCESS_DENIED');
    await expectGatewayError(harness.service.get('asset_1', testContext('tenant-a')), 'ACCESS_DENIED');
    await expectGatewayError(harness.service.identify({ type: 'asset', assetId: 'asset_1' }, testContext('tenant-a')), 'ACCESS_DENIED');
  });

  it('denies an unknown asset id', async () => {
    const harness = createHarness();
    const error = await expectGatewayError(harness.service.get('asset_missing', testContext()), 'ACCESS_DENIED');
    expect(error.code).not.toBe('JOB_NOT_FOUND');
  });
});

describe('managed asset mode', () => {
  const managedHarness = () => harnessWithUrl(PNG_BYTES, { config: { assetMode: 'managed' } });

  it('copies bytes into storage and returns a signed URL with an expiry', async () => {
    const { harness } = managedHarness();
    const stored = await harness.service.upload({ source: { url: SOURCE_URL } }, testContext());

    expect(harness.store.puts).toHaveLength(1);
    expect(harness.store.puts[0]?.key).toBe(`tenant-a/${stored.id}`);
    expect(harness.store.puts[0]?.contentType).toBe('image/png');
    expect(harness.store.puts[0]?.bytes).toEqual(PNG_BYTES);
    expect(stored.storageKey).toBe(`tenant-a/${stored.id}`);
    expect(stored.url).toContain('X-Amz-Signature');
    expect(stored.urlExpiresAt).toBe('2026-01-01T00:15:00.000Z');
    expect(harness.store.signRequests[0]?.expiresInSeconds).toBe(900);
  });

  it('re-signs on every read, producing a fresh expiry', async () => {
    const { harness } = managedHarness();
    const stored = await harness.service.upload({ source: { url: SOURCE_URL } }, testContext());

    harness.clock.advance(60_000);
    const first = await harness.service.get(stored.id, testContext());
    harness.clock.advance(60_000);
    const second = await harness.service.get(stored.id, testContext());

    expect(first.url).not.toBe(second.url);
    expect(first.urlExpiresAt).toBe('2026-01-01T00:16:00.000Z');
    expect(second.urlExpiresAt).toBe('2026-01-01T00:17:00.000Z');
    expect(harness.store.signRequests).toHaveLength(3);

    const persisted = await harness.repository.transaction(async (tx) => tx.getAsset('tenant-a', stored.id));
    expect(persisted?.url).toBe(second.url);
  });

  it('leaves no asset row and reports a retryable failure when the copy fails', async () => {
    const { harness } = managedHarness();
    harness.store.failPut = true;

    const error = await expectGatewayError(
      harness.service.upload({ source: { url: SOURCE_URL } }, testContext()),
      'MEDIA_UPLOAD_FAILED'
    );
    expect(error.retryable).toBe(true);
    const rows = await harness.repository.transaction(async (tx) => tx.listAssets('tenant-a', { limit: 10 }));
    expect(rows.assets).toHaveLength(0);
  });

  it('reports a signing failure as an internal error', async () => {
    const { harness } = managedHarness();
    harness.store.failSign = true;
    await expectGatewayError(harness.service.upload({ source: { url: SOURCE_URL } }, testContext()), 'INTERNAL_ERROR');
  });

  it('refuses to start without an object store', () => {
    const providerFactory: ProviderFactory = { providerId: 'higgsfield', forContext: async () => createFakeProvider() };
    expect(() =>
      createMediaService({
        repository: createMemoryJobRepository(),
        providerFactory,
        clock: createClock(),
        logger: createSilentLogger(),
        metrics: createNullMetrics(),
        config: { ...DEFAULT_CONFIG, assetMode: 'managed' }
      })
    ).toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });

  it('keeps the tenant partition even for hostile tenant identifiers', async () => {
    const { harness } = managedHarness();
    const stored: MediaAsset = await harness.service.upload(
      { source: { url: SOURCE_URL } },
      { ...testContext(), tenantId: '../../etc' }
    );
    expect(stored.storageKey).not.toContain('..');
    expect(stored.storageKey?.startsWith('etc-')).toBe(true);
    expect(stored.storageKey).not.toContain('/../');
  });
});

describe('passthrough asset mode', () => {
  it('returns provider URLs unchanged and never touches storage', async () => {
    const { harness } = harnessWithUrl();
    const stored = await harness.service.upload({ source: { url: SOURCE_URL } }, testContext());

    expect(stored.storageKey).toBeUndefined();
    expect(harness.store.puts).toHaveLength(0);
    expect(harness.store.signRequests).toHaveLength(0);
    const read = await harness.service.get(stored.id, testContext());
    expect(read.url).toBe(stored.url);
  });
});

describe('identify', () => {
  it('returns the asset identity for the owner', async () => {
    const harness = createHarness();
    await seedAsset(harness.repository, asset({ id: 'asset_9', tenantId: 'tenant-a', size: 42, mimeType: 'image/png' }));
    const identity = await harness.service.identify({ type: 'asset', assetId: 'asset_9' }, testContext());
    expect(identity).toEqual({ kind: 'asset', id: 'asset_9', mediaType: 'image', mimeType: 'image/png', size: 42 });
  });

  it('normalizes a URL without resolving or downloading it', async () => {
    const resolver = createResolverDouble([PUBLIC_ADDRESS]);
    const fetch = createFetchDouble(() => binaryResponse(TEXT_BYTES));
    const harness = createHarness({ fetchImpl: fetch.fetchImpl, resolveHost: resolver.resolveHost });

    const identity = await harness.service.identify(
      { type: 'url', url: 'https://CDN.Example.com:443/a/photo.PNG?token=abc' },
      testContext()
    );
    expect(identity).toEqual({ kind: 'url', id: 'https://cdn.example.com/a/photo.PNG?token=abc', mediaType: 'image' });
    expect(resolver.calls).toHaveLength(0);
    expect(fetch.calls).toHaveLength(0);
  });

  it('rejects a blocked URL at identify time', async () => {
    const harness = createHarness();
    await expectGatewayError(harness.service.identify({ type: 'url', url: 'https://127.0.0.1/a.png' }, testContext()), 'INVALID_INPUT');
  });

  it('hashes an allowlisted file rather than uploading it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-media-identify-'));
    const path = join(root, 'photo.png');
    writeFileSync(path, PNG_BYTES);

    const harness = createHarness({ config: { allowedPaths: [root], localFileAccess: true } });
    const identity = await harness.service.identify({ type: 'file', path }, testContext());
    expect(identity.kind).toBe('file');
    expect(identity.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(identity.mediaType).toBe('image');
    expect(identity.size).toBe(PNG_BYTES.byteLength);
    expect(harness.uploads).toHaveLength(0);
  });
});

describe('file references', () => {
  it('uploads an allowlisted file through the provider', async () => {
    const path = tempFile('photo.png', PNG_BYTES);
    const root = join(path, '..');
    const harness = createHarness({ provider: createFakeProvider(), config: { allowedPaths: [root], localFileAccess: true } });

    const stored = await harness.service.resolve({ type: 'file', path }, testContext());
    expect(stored.origin).toBe('upload');
    expect(stored.url).toContain('https://cdn.example.com/uploads/');
    expect(harness.uploads).toHaveLength(1);
    expect(harness.uploads[0]?.bytes).toEqual(PNG_BYTES);
  });

  it('rejects a file reference when local file access is disabled', async () => {
    const path = tempFile('photo.png', PNG_BYTES);
    const harness = createHarness({ provider: createFakeProvider(), config: { allowedPaths: ['/tmp'], localFileAccess: false } });
    await expectGatewayError(harness.service.resolve({ type: 'file', path }, testContext()), 'INVALID_INPUT');
  });

  it('rejects an unsupported reference shape without leaking internal errors', async () => {
    const harness = createHarness();
    const error = await expectGatewayError(
      harness.service.resolve({ type: 'ftp' } as unknown as { type: 'url'; url: string }, testContext()),
      'INVALID_INPUT'
    );
    expect(error.message).toBe('Unsupported media reference.');
  });
});
