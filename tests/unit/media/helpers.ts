import { expect } from 'vitest';
import type {
  Clock,
  MediaAsset,
  MediaProvider,
  MediaService,
  MetricsPort,
  ObjectStore,
  ProviderFactory,
  ProviderUploadInput
} from '../../../packages/core/src/contracts.js';
import { GatewayError } from '../../../packages/core/src/errors.js';
import { createMemoryJobRepository } from '../../../packages/core/src/jobs/memory-repository.js';
import type { JobRepository } from '../../../packages/core/src/jobs/repository.js';
import { createMediaService, type MediaServiceConfig, type MediaServiceOptions } from '../../../packages/core/src/media/service.js';
import { createSilentLogger, createNullMetrics, testContext, type RecordingLogger } from '../../fixtures/fakes.js';

/** A real 1x1 PNG payload, magic bytes included. */
export const PNG_BYTES = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
);

export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
export const TEXT_BYTES = new Uint8Array(Buffer.from('this file pretends to be an image but is plain text'));

/** Address used by the DNS double; never dialled because `fetch` is stubbed. */
export const PUBLIC_ADDRESS = '93.184.216.34';

export interface ResolverDouble {
  resolveHost: (hostname: string) => Promise<string[]>;
  readonly calls: string[];
}

export function createResolverDouble(addresses: string[] | ((hostname: string) => string[])): ResolverDouble {
  const calls: string[] = [];
  return {
    calls,
    resolveHost: async (hostname: string): Promise<string[]> => {
      calls.push(hostname);
      return typeof addresses === 'function' ? addresses(hostname) : addresses;
    }
  };
}

export interface FetchDouble {
  fetchImpl: typeof fetch;
  readonly calls: string[];
}

/** Minimal `fetch` double: the handler decides the response, nothing leaves the process. */
export function createFetchDouble(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>
): FetchDouble {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return await handler(url, init ?? undefined);
  };
  return { fetchImpl, calls };
}

export function binaryResponse(
  bytes: Uint8Array,
  init: { status?: number; contentType?: string; location?: string } = {}
): Response {
  const headers = new Headers();
  if (init.contentType !== undefined) headers.set('content-type', init.contentType);
  if (init.location !== undefined) headers.set('location', init.location);
  const status = init.status ?? 200;
  const body = status === 204 || status === 304 ? null : bytes;
  return new Response(body, { status, headers });
}

export interface ObjectStoreDouble extends ObjectStore {
  readonly puts: { key: string; bytes: Uint8Array; contentType: string }[];
  readonly signRequests: { key: string; expiresInSeconds: number }[];
  readonly deleted: string[];
  failPut: boolean;
  failSign: boolean;
  failHealth: boolean;
}

export function createObjectStoreDouble(): ObjectStoreDouble {
  const store: ObjectStoreDouble = {
    puts: [],
    signRequests: [],
    deleted: [],
    failPut: false,
    failSign: false,
    failHealth: false,
    async put(key, bytes, contentType) {
      if (store.failPut) throw new Error('storage unavailable');
      store.puts.push({ key, bytes, contentType });
    },
    async get(key) {
      const found = store.puts.find((entry) => entry.key === key);
      if (found === undefined) throw new Error('not found');
      return found.bytes;
    },
    async delete(key) {
      store.deleted.push(key);
    },
    async signedGetUrl(key, expiresInSeconds) {
      if (store.failSign) throw new Error('signing unavailable');
      // A distinct signature per call makes a re-sign observable.
      store.signRequests.push({ key, expiresInSeconds });
      return `https://store.example.com/${key}?X-Amz-Signature=sig-${store.signRequests.length}&X-Amz-Expires=${expiresInSeconds}`;
    },
    async health() {
      if (store.failHealth) throw new Error('unhealthy');
    }
  };
  return store;
}

export interface ProviderDouble {
  factory: ProviderFactory;
  /** Every `uploadMedia` call, in order, with the exact bytes handed to the provider. */
  readonly uploads: ProviderUploadInput[];
}

export function createProviderFactory(provider: MediaProvider): ProviderDouble {
  const uploads: ProviderUploadInput[] = [];
  const recording: MediaProvider = {
    ...provider,
    uploadMedia: async (input) => {
      uploads.push(input);
      return await provider.uploadMedia(input);
    }
  };
  return {
    uploads,
    factory: {
      providerId: provider.id,
      forContext: async (): Promise<MediaProvider> => recording
    }
  };
}

export function createClock(startIso = '2026-01-01T00:00:00.000Z'): Clock & { advance(ms: number): void } {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    }
  };
}

export const DEFAULT_CONFIG: MediaServiceConfig = {
  allowedPaths: [],
  assetMode: 'passthrough',
  maxUploadBytes: 16 * 1024 * 1024,
  downloadTimeoutMs: 5_000,
  maxRedirects: 3,
  signedUrlTtlSeconds: 900,
  localFileAccess: false
};

export interface ServiceHarness {
  readonly service: MediaService;
  readonly repository: JobRepository;
  readonly logger: RecordingLogger;
  readonly metrics: MetricsPort;
  readonly store: ObjectStoreDouble;
  readonly clock: Clock & { advance(ms: number): void };
  /** Bytes handed to the provider, when a provider double was supplied. */
  readonly uploads: ProviderUploadInput[];
}

export interface HarnessOverrides {
  config?: Partial<MediaServiceConfig>;
  provider?: MediaProvider;
  objectStore?: ObjectStoreDouble | undefined;
  fetchImpl?: typeof fetch | undefined;
  resolveHost?: ((hostname: string) => Promise<string[]>) | undefined;
}

export function createHarness(overrides: HarnessOverrides = {}): ServiceHarness {
  const config: MediaServiceConfig = { ...DEFAULT_CONFIG, ...overrides.config };
  const store = overrides.objectStore ?? createObjectStoreDouble();
  const clock = createClock();
  const logger = createSilentLogger();
  const metrics = createNullMetrics();
  const providerDouble = overrides.provider === undefined ? undefined : createProviderFactory(overrides.provider);
  const providerFactory: ProviderFactory = providerDouble?.factory ?? {
    providerId: 'higgsfield',
    forContext: async (): Promise<MediaProvider> => {
      throw new GatewayError('INTERNAL_ERROR', 'No provider was supplied to the media harness.');
    }
  };

  const objectStore = config.assetMode === 'managed' ? store : overrides.objectStore;
  const options: MediaServiceOptions = {
    repository: createMemoryJobRepository(),
    providerFactory,
    clock,
    logger,
    metrics,
    config,
    ...(objectStore === undefined ? {} : { objectStore }),
    ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
    ...(overrides.resolveHost === undefined ? {} : { resolveHost: overrides.resolveHost })
  };

  return {
    service: createMediaService(options),
    repository: options.repository,
    logger,
    metrics,
    store,
    clock,
    uploads: providerDouble?.uploads ?? []
  };
}

/** Asserts the promise rejects with a `GatewayError` carrying the expected code. */
export async function expectGatewayError(promise: Promise<unknown>, code: string): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    const gateway = error as GatewayError;
    expect(gateway.code).toBe(code);
    return gateway;
  }
  throw new Error(`expected a GatewayError with code ${code}, but the call succeeded`);
}

/** Inserts an asset row directly, for read-path tests. */
export async function seedAsset(repository: JobRepository, asset: MediaAsset): Promise<MediaAsset> {
  await repository.transaction(async (tx) => {
    await tx.insertAsset(asset);
  });
  return asset;
}

export function asset(overrides: Partial<MediaAsset> & { id: string; tenantId: string }): MediaAsset {
  return {
    provider: 'higgsfield',
    mediaType: 'image',
    mimeType: 'image/png',
    url: 'https://cdn.example.com/provider/asset.png',
    createdAt: '2026-01-01T00:00:00.000Z',
    origin: 'provider',
    ...overrides
  };
}

export { testContext };
