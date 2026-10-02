/**
 * Bundled, versioned Higgsfield model catalog.
 *
 * The data lives in `registry.json` (refreshed as a pull request, never at
 * request time) and is validated with zod on first load. Every entry carries the
 * documented `source.url` + `asOf` it was transcribed from, plus the provider's
 * own JSON Schema, so a reviewer can diff the catalog against the docs.
 *
 * The validated catalog is memoized and deeply frozen: it is build data, not
 * request state, and no caller can mutate it.
 */
import { CAPABILITIES, GatewayError } from '@higgsfield-mcp/core';
import type { ModelDefinition, ModelSource } from '@higgsfield-mcp/core';
import { z } from 'zod';
import { HIGGSFIELD_CATALOG_VERSION, HIGGSFIELD_PROVIDER_ID } from '../version.js';
import { isEndpointId, isUsableHttpUrl } from '../paths.js';
import { isRecord } from './validate.js';
import registry from './registry.json';

export interface HiggsfieldCatalogMetadata {
  catalogVersion: string;
  generatedFrom: string[];
  asOf: string;
}

/** A documented endpoint that is deliberately absent from the catalog. */
export interface UnavailableModelEntry {
  id: string;
  reason: string;
  source: ModelSource;
}

const sourceSchema = z.strictObject({
  url: z.string().min(1),
  asOf: z.string().min(1)
});

const modelLimitsSchema = z.strictObject({
  durationsSeconds: z.array(z.number().int().positive()).optional(),
  aspectRatios: z.array(z.string().min(1)).optional(),
  resolutions: z.array(z.string().min(1)).optional(),
  maxCount: z.number().int().nonnegative().optional(),
  maxReferenceImages: z.number().int().nonnegative().optional(),
  maxPromptLength: z.number().int().positive().optional(),
  maxUploadBytes: z.number().int().positive().optional(),
  supportedMimeTypes: z.array(z.string().min(1)).optional()
});

const pricingSchema = z.strictObject({
  currency: z.literal('USD'),
  unitMicroUsd: z.number().int().nonnegative().optional(),
  perSecondMicroUsd: z.number().int().nonnegative().optional(),
  source: z.string().min(1),
  asOf: z.string().min(1)
});

const modelDefinitionSchema = z.strictObject({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  provider: z.literal(HIGGSFIELD_PROVIDER_ID),
  type: z.enum(['image', 'video', 'audio', '3d']),
  endpoint: z.string().min(1).max(400),
  kind: z.enum(['generation', 'custom_reference']),
  concurrencyClass: z.enum(['image', 'video', 'other']),
  capabilities: z.array(z.string().min(1)).min(1),
  status: z.enum(['active', 'deprecated', 'experimental']),
  limits: modelLimitsSchema,
  inputSchema: z.record(z.string(), z.unknown()),
  pricing: pricingSchema.optional(),
  source: sourceSchema,
  exclusiveCapabilities: z.array(z.string().min(1)).optional()
});

const unavailableSchema = z.strictObject({
  id: z.string().min(1),
  reason: z.string().min(1),
  source: sourceSchema
});

const registrySchema = z.strictObject({
  catalogVersion: z.string().min(1),
  asOf: z.string().min(1),
  generatedFrom: z.array(z.string().min(1)).min(1),
  uploadContentTypes: z.array(z.string().min(1)).min(1),
  uploadUrlTtlSeconds: z.number().int().positive(),
  models: z.array(modelDefinitionSchema).min(1),
  defaultsByModelId: z.record(z.string(), z.record(z.string(), z.unknown())),
  unavailable: z.array(unavailableSchema)
});

const KNOWN_CAPABILITIES: Readonly<Record<string, true>> = Object.freeze(
  Object.fromEntries(Object.values(CAPABILITIES).map((capability): [string, true] => [capability, true]))
);

function deepFreeze<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (Array.isArray(value)) {
    for (const nested of value) deepFreeze(nested, depth + 1);
    return Object.freeze(value);
  }
  if (!isRecord(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested, depth + 1);
  return Object.freeze(value);
}

function catalogFailure(message: string, details?: Record<string, unknown>): GatewayError {
  return new GatewayError('INTERNAL_ERROR', message, details === undefined ? {} : { details });
}

interface ValidatedCatalog {
  models: readonly ModelDefinition[];
  byId: ReadonlyMap<string, ModelDefinition>;
  defaults: Readonly<Record<string, Record<string, unknown>>>;
  unavailable: readonly UnavailableModelEntry[];
  metadata: HiggsfieldCatalogMetadata;
  uploadContentTypes: readonly string[];
  uploadUrlTtlSeconds: number;
}

/**
 * Validated form of one raw registry document. Returned by
 * `validateCatalogRegistry`, which the catalog refresh workflow can run over a
 * proposed registry before it is committed.
 */
export interface ValidatedCatalogRegistry {
  catalogVersion: string;
  asOf: string;
  generatedFrom: string[];
  uploadContentTypes: string[];
  uploadUrlTtlSeconds: number;
  models: ModelDefinition[];
  defaultsByModelId: Record<string, Record<string, unknown>>;
  unavailable: UnavailableModelEntry[];
}

/**
 * Validates one raw registry document: shape (zod), version consistency, unique
 * ids and endpoints, safe endpoint ids, known capabilities, usable source URLs
 * and defaults that refer to real models. Throws `INTERNAL_ERROR` — this is build
 * data, never caller input.
 */
export function validateCatalogRegistry(raw: unknown): ValidatedCatalogRegistry {
  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw catalogFailure('The Higgsfield model catalog failed validation.', {
      issueCount: parsed.error.issues.length,
      issuePath: first?.path.join('.') ?? '',
      issueCode: first?.code ?? ''
    });
  }
  const data = parsed.data;
  if (data.catalogVersion !== HIGGSFIELD_CATALOG_VERSION) {
    throw catalogFailure('The Higgsfield model catalog version does not match the adapter constant.', {
      catalogVersion: data.catalogVersion
    });
  }

  const models: ModelDefinition[] = data.models;
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw catalogFailure('The Higgsfield model catalog contains a duplicate model id.');
    if (!isEndpointId(model.endpoint)) {
      throw catalogFailure('The Higgsfield model catalog contains an unsafe endpoint id.', { modelId: model.id });
    }
    if (endpoints.has(model.endpoint)) {
      throw catalogFailure('The Higgsfield model catalog maps two models to one endpoint.', { endpoint: model.endpoint });
    }
    if (!isUsableHttpUrl(model.source.url)) {
      throw catalogFailure('The Higgsfield model catalog contains an unusable source URL.', { modelId: model.id });
    }
    for (const capability of model.capabilities) {
      if (KNOWN_CAPABILITIES[capability] !== true) {
        throw catalogFailure('The Higgsfield model catalog contains an unknown capability.', {
          modelId: model.id,
          capability
        });
      }
    }
    ids.add(model.id);
    endpoints.add(model.endpoint);
  }

  for (const key of Object.keys(data.defaultsByModelId)) {
    if (!ids.has(key)) {
      throw catalogFailure('The Higgsfield model catalog has defaults for an unknown model.', { modelId: key });
    }
  }

  return {
    catalogVersion: data.catalogVersion,
    asOf: data.asOf,
    generatedFrom: [...data.generatedFrom],
    uploadContentTypes: [...data.uploadContentTypes],
    uploadUrlTtlSeconds: data.uploadUrlTtlSeconds,
    models,
    defaultsByModelId: data.defaultsByModelId,
    unavailable: [...data.unavailable]
  };
}

let cached: ValidatedCatalog | undefined;

function buildCatalog(): ValidatedCatalog {
  const validated = validateCatalogRegistry(registry);
  const byId = new Map<string, ModelDefinition>();
  for (const model of validated.models) byId.set(model.id, model);
  return {
    models: Object.freeze(deepFreeze(validated.models)),
    byId,
    defaults: deepFreeze(validated.defaultsByModelId),
    unavailable: Object.freeze(deepFreeze(validated.unavailable)),
    metadata: {
      catalogVersion: validated.catalogVersion,
      asOf: validated.asOf,
      generatedFrom: [...validated.generatedFrom]
    },
    uploadContentTypes: Object.freeze(validated.uploadContentTypes),
    uploadUrlTtlSeconds: validated.uploadUrlTtlSeconds
  };
}

function catalog(): ValidatedCatalog {
  cached ??= buildCatalog();
  return cached;
}

/** Every active catalog entry, in registry order. Elements are frozen. */
export function loadBundledCatalog(): ModelDefinition[] {
  return [...catalog().models];
}

/** Resolves a model by id or by documented endpoint id, or throws `MODEL_NOT_FOUND`. */
export function getModelDefinition(idOrEndpoint: string): ModelDefinition {
  const found = findModelDefinition(idOrEndpoint);
  if (found === undefined) {
    throw new GatewayError('MODEL_NOT_FOUND', 'Unknown or unsupported Higgsfield model.', {
      details: { requested: sanitizeIdentifier(idOrEndpoint) }
    });
  }
  return found;
}

/** Resolves a model by id or endpoint id; `undefined` when the catalog has no match. */
export function findModelDefinition(idOrEndpoint: string): ModelDefinition | undefined {
  if (typeof idOrEndpoint !== 'string' || idOrEndpoint.length === 0 || idOrEndpoint.length > 400) return undefined;
  const direct = catalog().byId.get(idOrEndpoint);
  if (direct !== undefined) return direct;
  for (const model of catalog().models) {
    if (model.endpoint === idOrEndpoint) return model;
  }
  return undefined;
}

function sanitizeIdentifier(value: string): string {
  return typeof value === 'string' ? value.slice(0, 80).replace(/[\u0000-\u001f\u007f]/g, '') : '';
}

/**
 * Documented defaults for one model, taken from the `default` values in the
 * provider's own JSON Schema. Returns a fresh object; entries are frozen.
 */
export function getDocumentedDefaults(modelId: string): Record<string, unknown> {
  const defaults = catalog().defaults[modelId];
  return defaults === undefined ? {} : { ...defaults };
}

/** Documented upload content types (MIME) accepted by `POST /files/generate-upload-url`. */
export function getUploadContentTypes(): string[] {
  return [...catalog().uploadContentTypes];
}

/** Documented lifetime of the presigned upload URL, in seconds. */
export function getUploadUrlTtlSeconds(): number {
  return catalog().uploadUrlTtlSeconds;
}

/** Catalog provenance: version, date and the documentation URLs it was read from. */
export function getCatalogMetadata(): HiggsfieldCatalogMetadata {
  const metadata = catalog().metadata;
  return {
    catalogVersion: metadata.catalogVersion,
    asOf: metadata.asOf,
    generatedFrom: [...metadata.generatedFrom]
  };
}

/** Documented endpoints the catalog intentionally does not expose, with the reason. */
export function getUnavailableModels(): UnavailableModelEntry[] {
  return catalog().unavailable.map((entry) => ({ id: entry.id, reason: entry.reason, source: { ...entry.source } }));
}
