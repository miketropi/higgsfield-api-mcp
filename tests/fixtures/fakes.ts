import type {
  CancellationOutcome,
  CostEstimate,
  GenerationRequest,
  LoggerPort,
  MediaAsset,
  MediaIdentity,
  MediaReference,
  MediaService,
  MetricsPort,
  ModelDefinition,
  ProviderGenerationRequest,
  ProviderJobSnapshot,
  ProviderMediaUpload,
  ProviderSubmissionOptions,
  ProviderSubmissionPlan,
  ProviderUploadInput,
  RequestContext
} from '@higgsfield-mcp/core';
import { canonicalJson, newId, sha256Hex } from '@higgsfield-mcp/core';

export interface ProviderCall {
  kind: 'prepare' | 'submit' | 'getJob' | 'cancel' | 'upload' | 'estimate';
  endpoint?: string;
  body?: Record<string, unknown>;
  bodyHash?: string;
  upstreamIdempotencyKey?: string;
  handle?: string;
  query?: Record<string, string> | undefined;
}

export interface FakeProviderOptions {
  idempotencySupport?: 'documented' | 'unknown';
  estimateMicroUsd?: number | undefined;
  /** Behaviour per submit attempt; index 0 for the first attempt. */
  submitResults?: (Error | ProviderJobSnapshot)[];
  /** Snapshots (or errors) returned by successive getJob calls; the last one repeats. */
  pollResults?: (ProviderJobSnapshot | Error)[];
  cancelOutcome?: CancellationOutcome;
  accountId?: string;
}

export interface FakeProvider extends MediaProviderLike {
  calls: ProviderCall[];
  submitCount(): number;
}

interface MediaProviderLike {
  readonly id: string;
  readonly version: string;
  readonly accountId: string;
  prepare(request: ProviderGenerationRequest): ProviderSubmissionPlan;
  submit(plan: ProviderSubmissionPlan, options: ProviderSubmissionOptions): Promise<ProviderJobSnapshot>;
  generate(request: ProviderGenerationRequest): Promise<ProviderJobSnapshot>;
  getJob(id: string): Promise<ProviderJobSnapshot>;
  cancelJob(id: string): Promise<CancellationOutcome>;
  uploadMedia(input: ProviderUploadInput): Promise<ProviderMediaUpload>;
  getModels(): Promise<ModelDefinition[]>;
  getModel(id: string): Promise<ModelDefinition>;
  estimateCost?(request: GenerationRequest): Promise<CostEstimate>;
  getIdempotencySupport?(): 'documented' | 'unknown';
}

function model(
  id: string,
  params: {
    endpoint?: string;
    type: ModelDefinition['type'];
    kind?: ModelDefinition['kind'];
    concurrencyClass?: ModelDefinition['concurrencyClass'];
    capabilities: string[];
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  }
): ModelDefinition {
  return {
    id,
    name: id,
    provider: 'higgsfield',
    type: params.type,
    endpoint: params.endpoint ?? id,
    kind: params.kind ?? 'generation',
    concurrencyClass: params.concurrencyClass ?? (params.type === 'video' ? 'video' : 'image'),
    capabilities: params.capabilities,
    status: 'active',
    limits: {},
    inputSchema: {
      type: 'object',
      properties: params.properties,
      ...(params.required === undefined ? {} : { required: params.required }),
      ...(params.additionalProperties === undefined ? {} : { additionalProperties: params.additionalProperties })
    },
    source: { url: 'https://docs.higgsfield.ai/', asOf: '2026-10-01' }
  };
}

export const TEST_CATALOG: ModelDefinition[] = [
  model('xai/grok-imagine-image-2.0', {
    type: 'image',
    capabilities: ['image_generation', 'image_edit', 'reference_images'],
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', minLength: 1 },
      quality: { enum: ['low', 'medium'] },
      image_urls: { type: 'array', items: { type: 'string' }, maxItems: 10, minItems: 0 },
      resolution: { enum: ['1k', '2k'] },
      aspect_ratio: { enum: ['auto', '1:1', '16:9', '9:16'] }
    }
  }),
  model('alibaba/qwen-image-3/edit', {
    type: 'image',
    capabilities: ['image_edit'],
    required: ['prompt', 'image_urls'],
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', minLength: 1 },
      image_urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
      aspect_ratio: { enum: ['1:1', '4:3', '3:4', '16:9', '9:16'] },
      seed: { type: 'integer', minimum: 0, maximum: 2147483647 }
    }
  }),
  model('kling-video/v2.5-turbo/pro/text-to-video', {
    type: 'video',
    capabilities: ['text_to_video'],
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', minLength: 1 },
      duration: { enum: [5, 10] },
      cfg_scale: { type: 'number', minimum: 0, maximum: 1 },
      negative_prompt: { type: 'string' }
    }
  }),
  model('kling-video/v2.5-turbo/pro/image-to-video', {
    type: 'video',
    capabilities: ['image_to_video'],
    required: ['prompt', 'image_url'],
    properties: {
      prompt: { type: 'string', minLength: 1 },
      image_url: { type: 'string' },
      duration: { enum: [5, 10] },
      negative_prompt: { type: 'string' }
    }
  }),
  model('bytedance/seedance-2.5/image-to-video', {
    type: 'video',
    capabilities: ['image_to_video', 'end_image'],
    required: ['image_url'],
    additionalProperties: false,
    properties: {
      image_url: { type: 'string' },
      prompt: { type: 'string', minLength: 1 },
      duration: { type: 'integer', minimum: 4, maximum: 30 },
      resolution: { enum: ['480p', '720p', '1080p'] },
      end_image_url: { type: 'string' },
      generate_audio: { type: 'boolean' }
    }
  }),
  model('bytedance/seedance-2.5/reference-to-video', {
    type: 'video',
    capabilities: ['reference_to_video'],
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', minLength: 1 },
      duration: { type: 'integer', minimum: 4, maximum: 30 },
      image_urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 30 },
      resolution: { enum: ['480p', '720p', '1080p'] },
      aspect_ratio: { enum: ['16:9', '9:16', '1:1'] },
      generate_audio: { type: 'boolean' }
    }
  }),
  model('soul-id', {
    endpoint: 'v1/custom-references',
    type: 'image',
    kind: 'custom_reference',
    concurrencyClass: 'other',
    capabilities: ['custom_reference_training'],
    required: ['name', 'input_images'],
    properties: {
      name: { type: 'string', maxLength: 100 },
      model_version: { enum: ['v1', 'v2', 'cinema'] },
      input_images: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          required: ['type', 'image_url'],
          properties: { type: { const: 'image_url' }, image_url: { type: 'string' } }
        }
      }
    }
  })
];

export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const calls: ProviderCall[] = [];
  const submitResults = [...(options.submitResults ?? [])];
  const pollResults = [...(options.pollResults ?? [])];
  let submitAttempts = 0;

  const provider: MediaProviderLike & { calls: ProviderCall[]; submitCount: () => number } = {
    id: 'higgsfield',
    version: '0.0.0-test',
    accountId: options.accountId ?? 'acct-test',
    calls,
    submitCount: () => submitAttempts,

    prepare(request) {
      const body = { ...request.input } as Record<string, unknown>;
      const plan: ProviderSubmissionPlan = {
        endpoint: request.endpoint,
        body,
        bodyHash: sha256Hex(canonicalJson(body)),
        jobKind: request.jobKind
      };
      if (request.webhook !== undefined) plan.query = { hf_webhook: request.webhook.url };
      if (request.webhook !== undefined) plan.webhook = { url: request.webhook.url };
      calls.push({ kind: 'prepare', endpoint: plan.endpoint, body, bodyHash: plan.bodyHash, query: plan.query });
      return plan;
    },

    async submit(plan, submitOptions) {
      submitAttempts += 1;
      calls.push({
        kind: 'submit',
        endpoint: plan.endpoint,
        body: plan.body,
        bodyHash: plan.bodyHash,
        ...(plan.query === undefined ? {} : { query: plan.query }),
        upstreamIdempotencyKey: submitOptions.upstreamIdempotencyKey
      });
      const next = submitResults.length > 1 ? submitResults.shift() : submitResults[0];
      if (next instanceof Error) throw next;
      if (next !== undefined) return { ...next, providerJobId: next.providerJobId };
      return { providerJobId: `generation:${newId('job').slice(4)}`, status: 'queued', assets: [] };
    },

    async generate(request) {
      return provider.submit(provider.prepare(request), { upstreamIdempotencyKey: request.upstreamIdempotencyKey });
    },

    async getJob(handle) {
      calls.push({ kind: 'getJob', handle });
      const next = pollResults.length > 1 ? pollResults.shift() : pollResults[0];
      if (next instanceof Error) throw next;
      if (next !== undefined) return next;
      return {
        providerJobId: handle,
        status: 'completed',
        assets: [{ url: 'https://cdn.example.com/out.png', mediaType: 'image', mimeType: 'image/png', size: 1234 }],
        cost: { currency: 'USD', actualMicroUsd: options.estimateMicroUsd ?? 90_000, source: 'estimate_api' }
      };
    },

    async cancelJob(handle) {
      calls.push({ kind: 'cancel', handle });
      return options.cancelOutcome ?? { accepted: true };
    },

    async uploadMedia(input) {
      calls.push({ kind: 'upload' });
      return {
        url: `https://cdn.example.com/uploads/${input.filename}`,
        provider: 'higgsfield',
        mediaType: input.mediaType,
        mimeType: input.mimeType,
        size: input.bytes.byteLength,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString()
      };
    },

    async getModels() {
      return TEST_CATALOG;
    },

    async getModel(id) {
      const found = TEST_CATALOG.find((entry) => entry.id === id);
      if (found === undefined) throw new Error(`unknown model ${id}`);
      return found;
    },

    ...(options.estimateMicroUsd === undefined
      ? {}
      : {
          async estimateCost(request: GenerationRequest): Promise<CostEstimate> {
            calls.push({ kind: 'estimate', endpoint: request.endpoint });
            return {
              microUsd: options.estimateMicroUsd as number,
              currency: 'USD',
              source: 'estimate_api',
              endpoint: request.endpoint,
              estimatedAt: new Date().toISOString()
            };
          }
        }),

    getIdempotencySupport: () => options.idempotencySupport ?? 'documented'
  };
  return provider;
}

export function createFakeMediaService(overrides: Partial<MediaService> = {}): MediaService {
  const asset = (reference: MediaReference): MediaAsset => {
    const url =
      reference.type === 'url'
        ? reference.url
        : reference.type === 'asset'
          ? `https://cdn.example.com/assets/${reference.assetId}.png`
          : `https://cdn.example.com/uploads/${reference.path.split('/').pop() ?? 'file'}`;
    return {
      id: newId('asset'),
      tenantId: 'tenant-a',
      provider: 'higgsfield',
      mediaType: 'image',
      mimeType: 'image/png',
      url,
      createdAt: new Date().toISOString(),
      origin: 'upload'
    };
  };
  return {
    async upload(input, context) {
      void context;
      return 'path' in input.source
        ? asset({ type: 'file', path: input.source.path })
        : asset({ type: 'url', url: input.source.url });
    },
    async get(id, context) {
      void context;
      return asset({ type: 'asset', assetId: id });
    },
    async resolve(reference) {
      return asset(reference);
    },
    async identify(reference): Promise<MediaIdentity> {
      if (reference.type === 'asset') return { kind: 'asset', id: reference.assetId, mediaType: 'image' };
      if (reference.type === 'url') return { kind: 'url', id: reference.url, mediaType: 'image' };
      return { kind: 'file', id: `file:${reference.path}`, mediaType: 'image' };
    },
    ...overrides
  };
}

export interface RecordingLogger extends LoggerPort {
  lines: Record<string, unknown>[];
}

export function createSilentLogger(): RecordingLogger {
  const lines: Record<string, unknown>[] = [];
  const make = (): RecordingLogger => ({
    lines,
    debug(obj) {
      lines.push(obj);
    },
    info(obj) {
      lines.push(obj);
    },
    warn(obj) {
      lines.push(obj);
    },
    error(obj) {
      lines.push(obj);
    },
    child() {
      return make();
    }
  });
  return make();
}

export function createNullMetrics(): MetricsPort {
  return {
    toolCall() {},
    toolError() {},
    jobStarted() {},
    jobFinished() {},
    providerRequest() {},
    providerError() {},
    mediaUploadBytes() {},
    estimatedCostUsd() {},
    activeJobs() {},
    queuedJobs() {}
  };
}

export function testContext(tenantId = 'tenant-a'): RequestContext {
  return {
    requestId: 'req_test',
    tenantId,
    transport: 'stdio',
    auth: { tenantId, mode: 'stdio', scopes: ['higgsfield:read', 'higgsfield:generate', 'higgsfield:upload'] }
  };
}
