/**
 * Contract tests for the bundled, versioned model catalog: every entry validates,
 * ids and endpoints are unique and safe, the Soul ID entry is a custom-reference
 * lifecycle, and the validation rejects a malformed registry.
 */
import { describe, expect, it } from 'vitest';
import {
  HIGGSFIELD_CATALOG_VERSION,
  HIGGSFIELD_PROVIDER_ID,
  findModelDefinition,
  getCatalogMetadata,
  getDocumentedDefaults,
  getModelDefinition,
  getUnavailableModels,
  getUploadContentTypes,
  getUploadUrlTtlSeconds,
  loadBundledCatalog,
  validateCatalogRegistry
} from '@higgsfield-mcp/provider-higgsfield';
import type { ValidatedCatalogRegistry } from '@higgsfield-mcp/provider-higgsfield';
import type { ModelDefinition } from '@higgsfield-mcp/core';

const ENDPOINT_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/;

const REQUIRED_MODEL_IDS = [
  'xai/grok-imagine-image-2.0',
  'alibaba/qwen-image-3/edit',
  'kling-video/v2.5-turbo/pro/text-to-video',
  'kling-video/v2.5-turbo/pro/image-to-video',
  'bytedance/seedance-2.5/image-to-video',
  'bytedance/seedance-2.5/reference-to-video',
  'soul-id'
];

function baseModel(): ModelDefinition {
  const model = loadBundledCatalog().find((candidate) => candidate.id === 'xai/grok-imagine-image-2.0');
  if (model === undefined) throw new Error('The bundled catalog lost its Grok entry.');
  return model;
}

function schemaKeyword(model: ModelDefinition, keyword: string): unknown {
  const schema = model.inputSchema;
  if (schema === null || typeof schema !== 'object') return undefined;
  return schema[keyword];
}

function propertyCount(model: ModelDefinition): number {
  const properties = schemaKeyword(model, 'properties');
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return 0;
  return Object.keys(properties).length;
}

function registryWith(models: ModelDefinition[]): Record<string, unknown> {
  return {
    catalogVersion: HIGGSFIELD_CATALOG_VERSION,
    asOf: '2026-10-02',
    generatedFrom: ['https://docs.higgsfield.ai/docs/models.md'],
    uploadContentTypes: ['image/png'],
    uploadUrlTtlSeconds: 3600,
    models,
    defaultsByModelId: {},
    unavailable: []
  };
}

describe('bundled catalog', () => {
  it('loads, validates and exposes every required documented model', () => {
    const models = loadBundledCatalog();
    expect(models.length).toBeGreaterThanOrEqual(REQUIRED_MODEL_IDS.length);
    for (const id of REQUIRED_MODEL_IDS) {
      expect(models.map((model) => model.id)).toContain(id);
    }
  });

  it('keeps model ids and endpoints unique', () => {
    const models = loadBundledCatalog();
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
    expect(new Set(models.map((model) => model.endpoint)).size).toBe(models.length);
  });

  it('describes every entry completely and consistently', () => {
    for (const model of loadBundledCatalog()) {
      expect(model.provider).toBe(HIGGSFIELD_PROVIDER_ID);
      expect(model.endpoint).toMatch(ENDPOINT_PATTERN);
      expect(model.capabilities.length).toBeGreaterThan(0);
      expect(model.status).toBe('active');
      expect(model.kind === 'generation' || model.kind === 'custom_reference').toBe(true);
      expect(['image', 'video', 'other']).toContain(model.concurrencyClass);
      expect(model.source.url.startsWith('https://docs.higgsfield.ai/')).toBe(true);
      expect(model.source.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(model.inputSchema).toBeDefined();
      expect(schemaKeyword(model, 'type')).toBe('object');
      expect(propertyCount(model)).toBeGreaterThan(0);
    }
  });

  it('exposes the reference-image capability the semantic image router depends on', () => {
    const grok = getModelDefinition('xai/grok-imagine-image-2.0');
    // Documented: "omit image_urls for generation, or supply up to 10 references for editing".
    expect(grok.capabilities).toEqual(
      expect.arrayContaining(['image_generation', 'image_edit', 'reference_images'])
    );
    expect(grok.limits.maxReferenceImages).toBe(10);
  });

  it('marks Soul ID training as the only custom-reference lifecycle', () => {
    const custom = loadBundledCatalog().filter((model) => model.kind === 'custom_reference');
    expect(custom).toHaveLength(1);
    expect(custom[0]?.id).toBe('soul-id');
    expect(custom[0]?.endpoint).toBe('v1/custom-references');
    // Training only: every documented consumer of `custom_reference_id`
    // (higgsfield-ai/soul/standard, .../soul/v2/standard, text2image_soul_v2,
    // soul_cinematic) is absent from the catalog, so no endpoint here can serve
    // `identity_generation` and the catalog must not advertise it.
    expect(custom[0]?.capabilities).toEqual(['custom_reference_training']);
    expect(custom[0]?.capabilities).not.toContain('identity_generation');
    expect(custom[0]?.limits.maxReferenceImages).toBe(100);
  });

  it('freezes catalog entries so no consumer can mutate shared state', () => {
    const model = baseModel();
    expect(Object.isFrozen(model)).toBe(true);
    expect(Reflect.set(model, 'id', 'mutated')).toBe(false);
    expect(model.id).toBe('xai/grok-imagine-image-2.0');
  });

  it('resolves models by id and by endpoint, and reports unknown ids as MODEL_NOT_FOUND', () => {
    expect(getModelDefinition('soul-id').endpoint).toBe('v1/custom-references');
    expect(getModelDefinition('v1/custom-references').id).toBe('soul-id');
    expect(findModelDefinition('kling-video/v2.5-turbo/pro/image-to-video')?.kind).toBe('generation');
    expect(findModelDefinition('not-a-model')).toBeUndefined();
    expect(() => getModelDefinition('not-a-model')).toThrowError(
      expect.objectContaining({ code: 'MODEL_NOT_FOUND' })
    );
    expect(() => getModelDefinition('../../etc/passwd')).toThrowError(
      expect.objectContaining({ code: 'MODEL_NOT_FOUND' })
    );
  });

  it('reports catalog provenance and the documented upload policy', () => {
    const metadata = getCatalogMetadata();
    expect(metadata.catalogVersion).toBe(HIGGSFIELD_CATALOG_VERSION);
    expect(metadata.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(metadata.generatedFrom.length).toBeGreaterThanOrEqual(7);

    expect(getUploadContentTypes()).toEqual([
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/gif',
      'audio/wav',
      'audio/x-wav',
      'video/mp4'
    ]);
    expect(getUploadUrlTtlSeconds()).toBe(3600);
  });

  it('records excluded endpoints with a reason instead of guessing', () => {
    const unavailable = getUnavailableModels();
    expect(unavailable.length).toBeGreaterThan(0);
    for (const entry of unavailable) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.source.url.startsWith('https://')).toBe(true);
      expect(loadBundledCatalog().map((model) => model.id)).not.toContain(entry.id);
    }
  });

  it('exposes the documented defaults that prepare() applies', () => {
    expect(getDocumentedDefaults('xai/grok-imagine-image-2.0')).toEqual({
      quality: 'medium',
      resolution: '1k',
      aspect_ratio: 'auto'
    });
    expect(getDocumentedDefaults('soul-id')).toEqual({ model_version: 'v1' });
    expect(getDocumentedDefaults('not-a-model')).toEqual({});
  });
});

describe('validateCatalogRegistry', () => {
  it('accepts a well-formed registry', () => {
    const validated: ValidatedCatalogRegistry = validateCatalogRegistry(registryWith([baseModel()]));
    expect(validated.models).toHaveLength(1);
    expect(validated.catalogVersion).toBe(HIGGSFIELD_CATALOG_VERSION);
  });

  it('rejects a duplicate model id', () => {
    const model = baseModel();
    expect(() => validateCatalogRegistry(registryWith([model, { ...model, endpoint: 'xai/other' }]))).toThrowError(
      expect.objectContaining({ code: 'INTERNAL_ERROR' })
    );
  });

  it('rejects two models sharing one endpoint', () => {
    const model = baseModel();
    expect(() => validateCatalogRegistry(registryWith([model, { ...model, id: 'xai/other' }]))).toThrowError(
      expect.objectContaining({ code: 'INTERNAL_ERROR' })
    );
  });

  it('rejects an endpoint id with traversal', () => {
    const model: ModelDefinition = { ...baseModel(), endpoint: '../../etc/passwd' };
    expect(() => validateCatalogRegistry(registryWith([model]))).toThrowError(
      expect.objectContaining({ code: 'INTERNAL_ERROR' })
    );
  });

  it('rejects an endpoint id containing a query string', () => {
    const model: ModelDefinition = { ...baseModel(), endpoint: 'xai/grok?redirect=https://evil.example' };
    expect(() => validateCatalogRegistry(registryWith([model]))).toThrowError(
      expect.objectContaining({ code: 'INTERNAL_ERROR' })
    );
  });

  it('rejects an unknown capability', () => {
    const model: ModelDefinition = { ...baseModel(), capabilities: ['image_generation', 'telekinesis'] };
    expect(() => validateCatalogRegistry(registryWith([model]))).toThrowError(
      expect.objectContaining({ code: 'INTERNAL_ERROR' })
    );
  });

  it('rejects a registry whose version constant drifted', () => {
    const raw = registryWith([baseModel()]);
    expect(() => validateCatalogRegistry({ ...raw, catalogVersion: '1999-01-01.0' })).toThrowError(
      expect.objectContaining({ code: 'INTERNAL_ERROR' })
    );
  });

  it('rejects defaults that refer to an unknown model', () => {
    const raw = registryWith([baseModel()]);
    expect(() =>
      validateCatalogRegistry({ ...raw, defaultsByModelId: { 'not-a-model': { quality: 'low' } } })
    ).toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });

  it('rejects entries with an unusable source URL', () => {
    const model: ModelDefinition = { ...baseModel(), source: { url: 'not-a-url', asOf: '2026-10-02' } };
    expect(() => validateCatalogRegistry(registryWith([model]))).toThrowError(
      expect.objectContaining({ code: 'INTERNAL_ERROR' })
    );
  });

  it('rejects a registry with no models at all', () => {
    expect(() => validateCatalogRegistry(registryWith([]))).toThrowError(
      expect.objectContaining({ code: 'INTERNAL_ERROR' })
    );
  });
});
