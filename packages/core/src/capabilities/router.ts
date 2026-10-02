import type { MediaReference, ModelDefinition, ModelRegistry } from '../contracts.js';
import { CAPABILITIES } from '../contracts.js';
import { GatewayError } from '../errors.js';

export interface RoutedRequest {
  /**
   * Provider endpoint id as documented by the provider. For most models this equals
   * the registry model id; Soul training differs (`soul-id` vs `v1/custom-references`).
   */
  endpoint: string;
  model: ModelDefinition;
  /** Primary capability the caller requested. */
  capability: string;
  /** Provider-flat input; media fields still hold `MediaReference` values. */
  input: Record<string, unknown>;
  /** Semantic route key, when the caller used one. */
  route?: string | undefined;
}

/** Semantic route keys accepted as `endpoint` by the semantic tools. */
export const SEMANTIC_ROUTES = [
  'image.default',
  'image.edit',
  'video.default',
  'video.image_to_video',
  'video.reference_to_video'
] as const;
export type SemanticRoute = (typeof SEMANTIC_ROUTES)[number];

const DEFAULT_MODEL_BY_ROUTE: Readonly<Record<SemanticRoute, string>> = {
  'image.default': 'xai/grok-imagine-image-2.0',
  'image.edit': 'alibaba/qwen-image-3/edit',
  'video.default': 'kling-video/v2.5-turbo/pro/text-to-video',
  'video.image_to_video': 'kling-video/v2.5-turbo/pro/image-to-video',
  'video.reference_to_video': 'bytedance/seedance-2.5/reference-to-video'
};

/**
 * Deterministic `video.default` branch selection: the requested inputs decide the
 * endpoint, because no single published endpoint accepts every input shape.
 */
const VIDEO_BRANCH_MODEL: Readonly<Record<string, string>> = {
  end_image: 'bytedance/seedance-2.5/image-to-video',
  references: 'bytedance/seedance-2.5/reference-to-video',
  start_image: 'kling-video/v2.5-turbo/pro/image-to-video',
  text: 'kling-video/v2.5-turbo/pro/text-to-video'
};

/** Documented quality vocabulary translation; anything else has no equivalent. */
const QUALITY_BY_SEMANTIC: Readonly<Record<string, string>> = {
  draft: 'low',
  standard: 'medium'
};

export function isSemanticRoute(endpoint: string): endpoint is SemanticRoute {
  return (SEMANTIC_ROUTES as readonly string[]).includes(endpoint);
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new GatewayError('INVALID_INPUT', message, details === undefined ? {} : { details });
}

function unsupported(model: ModelDefinition, feature: string): never {
  throw new GatewayError('INVALID_INPUT', `Model ${model.id} has no documented equivalent for ${feature}.`, {
    details: { model: model.id, feature }
  });
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) invalid(`${key} must be a non-empty string.`, { key });
  return value;
}

function readInteger(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid(`${key} must be an integer.`, { key });
  return value;
}

function readBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalid(`${key} must be a boolean.`, { key });
  return value;
}

function parseMediaReference(value: unknown, label: string): MediaReference {
  if (typeof value !== 'object' || value === null) invalid(`${label} must be a media reference.`, { label });
  const candidate = value as Record<string, unknown>;
  if (candidate['type'] === 'url' && typeof candidate['url'] === 'string') {
    return { type: 'url', url: candidate['url'] };
  }
  if (candidate['type'] === 'asset') {
    const assetId = candidate['assetId'] ?? candidate['asset_id'];
    if (typeof assetId === 'string' && assetId.length > 0) return { type: 'asset', assetId };
  }
  if (candidate['type'] === 'file' && typeof candidate['path'] === 'string' && candidate['path'].length > 0) {
    return { type: 'file', path: candidate['path'] };
  }
  return invalid(`${label} must be {url}, {asset_id} or {file path}.`, { label });
}

function readMediaReference(input: Record<string, unknown>, key: string): MediaReference | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  return parseMediaReference(value, key);
}

function readMediaList(input: Record<string, unknown>, key: string): MediaReference[] {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(`${key} must be an array of media references.`, { key });
  return value.map((item, index) => parseMediaReference(item, `${key}[${index}]`));
}

function declaredProperties(model: ModelDefinition): Record<string, unknown> {
  const schema = model.inputSchema;
  const properties = schema?.['properties'];
  return typeof properties === 'object' && properties !== null ? (properties as Record<string, unknown>) : {};
}

function assertFieldDeclared(model: ModelDefinition, field: string, feature: string): void {
  if (!(field in declaredProperties(model))) unsupported(model, feature);
}

function requiresField(model: ModelDefinition, field: string): boolean {
  const required = model.inputSchema?.['required'];
  return Array.isArray(required) && required.includes(field);
}

function resolveModel(
  route: SemanticRoute,
  registry: ModelRegistry,
  explicit: string | undefined,
  requiredCapabilities: string[],
  branch?: string
): ModelDefinition {
  const aliased = registry.aliases()[route];
  const model =
    explicit !== undefined
      ? registry.get(explicit)
      : aliased !== undefined && branch === undefined
        ? registry.get(aliased)
        : registry.get(branch === undefined ? DEFAULT_MODEL_BY_ROUTE[route] : (VIDEO_BRANCH_MODEL[branch] as string));
  for (const capability of requiredCapabilities) {
    if (!model.capabilities.includes(capability)) {
      throw new GatewayError('INVALID_INPUT', `Model ${model.id} cannot perform ${capability}.`, {
        details: { model: model.id, capability, supported: model.capabilities }
      });
    }
  }
  return model;
}

function routeImageDefault(
  registry: ModelRegistry,
  input: Record<string, unknown>,
  explicit: string | undefined
): RoutedRequest {
  const prompt = readString(input, 'prompt') ?? invalid('prompt is required.');
  const references = readMediaList(input, 'reference_images');
  const required = references.length > 0 ? [CAPABILITIES.imageGeneration, CAPABILITIES.referenceImages] : [CAPABILITIES.imageGeneration];
  const model = resolveModel('image.default', registry, explicit, required);
  const out: Record<string, unknown> = { prompt };

  const quality = readString(input, 'quality');
  if (quality !== undefined) {
    const mapped = QUALITY_BY_SEMANTIC[quality];
    if (mapped === undefined) invalid(`quality "${quality}" has no documented equivalent on ${model.id}.`, { quality });
    assertFieldDeclared(model, 'quality', 'quality');
    out['quality'] = mapped;
  }
  const aspectRatio = readString(input, 'aspect_ratio');
  if (aspectRatio !== undefined) {
    assertFieldDeclared(model, 'aspect_ratio', 'aspect_ratio');
    out['aspect_ratio'] = aspectRatio;
  }
  const resolution = readString(input, 'resolution');
  if (resolution !== undefined) {
    assertFieldDeclared(model, 'resolution', 'resolution');
    out['resolution'] = resolution;
  }
  const negativePrompt = readString(input, 'negative_prompt');
  if (negativePrompt !== undefined) {
    assertFieldDeclared(model, 'negative_prompt', 'negative_prompt');
    out['negative_prompt'] = negativePrompt;
  }
  const seed = readInteger(input, 'seed');
  if (seed !== undefined) {
    assertFieldDeclared(model, 'seed', 'seed');
    out['seed'] = seed;
  }
  const count = readInteger(input, 'count');
  if (count !== undefined && count > 1) unsupported(model, 'count > 1 (no documented batch field)');
  if (input['width'] !== undefined) unsupported(model, 'width');
  if (input['height'] !== undefined) unsupported(model, 'height');
  if (input['style'] !== undefined) unsupported(model, 'style');
  if (references.length > 0) {
    assertFieldDeclared(model, 'image_urls', 'reference_images');
    out['image_urls'] = references;
  }
  return {
    endpoint: model.endpoint,
    model,
    capability: references.length > 0 ? CAPABILITIES.referenceImages : CAPABILITIES.imageGeneration,
    input: out,
    route: 'image.default'
  };
}

function routeImageEdit(
  registry: ModelRegistry,
  input: Record<string, unknown>,
  explicit: string | undefined
): RoutedRequest {
  const prompt = readString(input, 'prompt') ?? invalid('prompt is required.');
  const image = readMediaReference(input, 'image') ?? invalid('image is required.');
  const references = readMediaList(input, 'references');
  const model = resolveModel('image.edit', registry, explicit, [CAPABILITIES.imageEdit]);
  assertFieldDeclared(model, 'image_urls', 'image');
  if (readMediaReference(input, 'mask') !== undefined) unsupported(model, 'mask');
  if (readBoolean(input, 'preserve_identity') !== undefined) unsupported(model, 'preserve_identity');
  const out: Record<string, unknown> = { prompt, image_urls: [image, ...references] };
  const aspectRatio = readString(input, 'aspect_ratio');
  if (aspectRatio !== undefined) {
    assertFieldDeclared(model, 'aspect_ratio', 'aspect_ratio');
    out['aspect_ratio'] = aspectRatio;
  }
  const seed = readInteger(input, 'seed');
  if (seed !== undefined) {
    assertFieldDeclared(model, 'seed', 'seed');
    out['seed'] = seed;
  }
  return { endpoint: model.endpoint, model, capability: CAPABILITIES.imageEdit, input: out, route: 'image.edit' };
}

function routeVideo(
  route: SemanticRoute,
  registry: ModelRegistry,
  input: Record<string, unknown>,
  explicit: string | undefined
): RoutedRequest {
  const prompt = readString(input, 'prompt');
  const startImage = readMediaReference(input, 'start_image') ?? readMediaReference(input, 'image');
  const endImage = readMediaReference(input, 'end_image');
  const references = readMediaList(input, 'references');

  const required: string[] = [];
  if (route === 'video.image_to_video') {
    required.push(CAPABILITIES.imageToVideo);
    if (startImage === undefined) invalid('start_image (or image) is required for image-to-video.');
  } else if (route === 'video.reference_to_video') {
    required.push(CAPABILITIES.referenceToVideo);
    if (references.length === 0 && startImage === undefined) invalid('references is required for reference-to-video.');
  } else if (endImage !== undefined) {
    required.push(CAPABILITIES.imageToVideo, CAPABILITIES.endImage);
    if (startImage === undefined) invalid('end_image requires start_image.');
  } else if (references.length > 0) {
    required.push(CAPABILITIES.referenceToVideo);
  } else if (startImage !== undefined) {
    required.push(CAPABILITIES.imageToVideo);
  } else {
    required.push(CAPABILITIES.textToVideo);
  }

  const branch =
    route !== 'video.default'
      ? undefined
      : endImage !== undefined
        ? 'end_image'
        : references.length > 0
          ? 'references'
          : startImage !== undefined
            ? 'start_image'
            : 'text';
  const model = resolveModel(route, registry, explicit, required, branch);
  const out: Record<string, unknown> = {};
  if (prompt !== undefined) out['prompt'] = prompt;
  else if (requiresField(model, 'prompt')) invalid(`prompt is required for ${model.id}.`);

  if (startImage !== undefined) {
    assertFieldDeclared(model, 'image_url', 'start_image');
    out['image_url'] = startImage;
  }
  if (endImage !== undefined) {
    assertFieldDeclared(model, 'end_image_url', 'end_image');
    out['end_image_url'] = endImage;
  }
  if (references.length > 0) {
    assertFieldDeclared(model, 'image_urls', 'references');
    out['image_urls'] = references;
  }
  const duration = readInteger(input, 'duration');
  if (duration !== undefined) {
    assertFieldDeclared(model, 'duration', 'duration');
    out['duration'] = duration;
  }
  const aspectRatio = readString(input, 'aspect_ratio');
  if (aspectRatio !== undefined) {
    assertFieldDeclared(model, 'aspect_ratio', 'aspect_ratio');
    out['aspect_ratio'] = aspectRatio;
  }
  const resolution = readString(input, 'resolution');
  if (resolution !== undefined) {
    assertFieldDeclared(model, 'resolution', 'resolution');
    out['resolution'] = resolution;
  }
  const audio = readBoolean(input, 'audio');
  if (audio !== undefined) {
    assertFieldDeclared(model, 'generate_audio', 'audio');
    out['generate_audio'] = audio;
  }
  if (input['quality'] !== undefined) unsupported(model, 'quality');
  if (input['motion_strength'] !== undefined) unsupported(model, 'motion_strength');
  if (input['camera_motion'] !== undefined) unsupported(model, 'camera_motion');
  return {
    endpoint: model.endpoint,
    model,
    capability: required.at(-1) ?? CAPABILITIES.textToVideo,
    input: out,
    route
  };
}

/**
 * Deterministic semantic routing (SPEC §20, plan §7). Explicit model overrides must
 * support every requested feature or fail `INVALID_INPUT`: no silent feature dropping
 * and no automatic provider fallback.
 */
export function routeRequest(params: {
  tool: string;
  endpoint: string;
  input: Record<string, unknown>;
  registry: ModelRegistry;
}): RoutedRequest {
  const { endpoint, input, registry } = params;
  const explicit = readString(input, 'model');
  if (!isSemanticRoute(endpoint)) {
    // Registered models are addressed by model id, but the provider docs (and the
    // generated skills) also use the documented endpoint id, and for Soul training
    // those differ ("soul-id" vs "v1/custom-references"). Accept either.
    const model =
      registry.list().find((candidate) => candidate.id === endpoint || candidate.endpoint === endpoint) ??
      registry.get(endpoint);
    const nativeInput = { ...input };
    delete nativeInput['model'];
    return {
      endpoint: model.endpoint,
      model,
      capability: model.capabilities[0] ?? 'generation',
      input: nativeInput
    };
  }
  switch (endpoint) {
    case 'image.default':
      return routeImageDefault(registry, input, explicit);
    case 'image.edit':
      return routeImageEdit(registry, input, explicit);
    case 'video.default':
    case 'video.image_to_video':
    case 'video.reference_to_video':
      return routeVideo(endpoint, registry, input, explicit);
    default: {
      const exhaustive: never = endpoint;
      return invalid(`Unsupported semantic route: ${String(exhaustive)}.`);
    }
  }
}
