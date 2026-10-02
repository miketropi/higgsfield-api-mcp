import { describe, expect, it } from 'vitest';
import type { Clock, DiscoveredModel } from '@higgsfield-mcp/core';
import { createModelRegistry } from '@higgsfield-mcp/core';
import {
  DISCOVERY_CACHE_TTL_MS,
  DISCOVERY_WARNING_LIMIT,
  canonicalSchemaJson,
  createModelDiscovery,
  createDocumentationFetcher,
  DocumentationFetchError,
  extractCompleteSchema,
  extractEndpointMetadata,
  extractLinks,
  findSection,
  isAllowedDocumentationUrl,
  parseWorkflowTable,
  schemaReferenceProblem
} from '@higgsfield-mcp/provider-higgsfield';
import type { ModelDiscovery } from '@higgsfield-mcp/core';
import { createDocsFixture, FIXTURE_DOCS_ORIGIN, FIXTURE_MANIFEST } from '../../fixtures/docs-directory.js';
import type { DocsFixture, FixtureWorkflowSpec } from '../../fixtures/docs-directory.js';

interface Harness {
  docs: DocsFixture;
  discovery: ModelDiscovery;
  advance(ms: number): void;
}

function harness(options: { docs?: DocsFixture; workflows?: FixtureWorkflowSpec[]; maxResponseBytes?: number } = {}): Harness {
  const docs =
    options.docs ??
    (options.workflows === undefined ? createDocsFixture() : createDocsFixture({ workflows: options.workflows }));
  const registry = createModelRegistry({ models: [...FIXTURE_MANIFEST] });
  let current = new Date('2026-10-03T00:00:00.000Z');
  const clock: Clock = { now: () => current };
  const discovery = createModelDiscovery({
    manifest: registry,
    fetch: docs.fetch,
    clock,
    ...(options.maxResponseBytes === undefined ? {} : { limits: { maxResponseBytes: options.maxResponseBytes } })
  });
  return {
    docs,
    discovery,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    }
  };
}

function byId(models: readonly DiscoveredModel[], id: string): DiscoveredModel {
  const found = models.find((model) => model.id === id);
  if (found === undefined) throw new Error(`fixture did not discover ${id}`);
  return found;
}

describe('documentation fetch policy', () => {
  it('accepts only HTTPS documentation URLs under /docs/models', () => {
    expect(isAllowedDocumentationUrl('https://docs.higgsfield.ai/docs/models.md')).toBe(true);
    expect(isAllowedDocumentationUrl('https://docs.higgsfield.ai/docs/models/a/b.md')).toBe(true);
    for (const rejected of [
      'http://docs.higgsfield.ai/docs/models.md',
      'https://docs.higgsfield.ai/docs/openapi.json',
      'https://api.higgsfield.ai/docs/models.md',
      'https://docs.higgsfield.ai.evil.example/docs/models.md',
      'https://docs.higgsfield.ai/docs/models.md?x=1',
      'https://docs.higgsfield.ai/docs/models.md#frag',
      'https://user:pass@docs.higgsfield.ai/docs/models.md',
      'https://docs.higgsfield.ai:8443/docs/models.md',
      'https://docs.higgsfield.ai/docs/models/%2e%2e/secret.md',
      'https://docs.higgsfield.ai/docs/models/%2Fetc%2Fpasswd.md'
    ]) {
      expect(isAllowedDocumentationUrl(rejected), rejected).toBe(false);
    }
  });

  it('never sends credentials and refuses oversized responses and off-site redirects', async () => {
    const docs = createDocsFixture();
    const fetcher = createDocumentationFetcher({ fetch: docs.fetch, limits: { maxResponseBytes: 64 } });
    await expect(fetcher.fetchPage(`${FIXTURE_DOCS_ORIGIN}/docs/models.md`)).rejects.toMatchObject({
      reason: 'response_too_large'
    });
    for (const request of docs.requests) {
      expect(Object.keys(request.headers)).not.toContain('authorization');
    }

    docs.addRedirect('/docs/models/grok-image-2.md', 'https://example.com/elsewhere.md');
    const redirected = createDocumentationFetcher({ fetch: docs.fetch });
    await expect(redirected.fetchPage(`${FIXTURE_DOCS_ORIGIN}/docs/models/grok-image-2.md`)).rejects.toBeInstanceOf(
      DocumentationFetchError
    );
    expect(docs.requests.some((request) => request.url.startsWith('https://example.com'))).toBe(false);
  });

  it('stops after the redirect budget', async () => {
    const docs = createDocsFixture();
    docs.addRedirect('/docs/models.md', '/docs/models.md');
    const fetcher = createDocumentationFetcher({ fetch: docs.fetch });
    await expect(fetcher.fetchPage(`${FIXTURE_DOCS_ORIGIN}/docs/models.md`)).rejects.toMatchObject({
      reason: 'too_many_redirects'
    });
  });
});

describe('documentation parser', () => {
  it('bounds sections by same-or-higher headings outside fenced code', () => {
    const page = [
      '# Family',
      '',
      '## Workflows',
      '',
      '| Workflow | Endpoint |',
      '| - | - |',
      '| [A](/docs/models/a/x) | `POST /a/x` |',
      '',
      '```md',
      '## Not a section',
      '| [B](/docs/models/a/y) | `POST /a/y` |',
      '```',
      '',
      '## Related topics',
      '',
      '- [C](/docs/models/a/z)'
    ].join('\n');
    const section = findSection(page, 'Workflows');
    expect(section).toBeDefined();
    expect(section).not.toContain('Not a section');
    expect(section).not.toContain('/docs/models/a/z');
    expect(parseWorkflowTable(section as string)).toEqual([
      { name: 'A', target: '/docs/models/a/x', endpoint: 'a/x' }
    ]);
    expect(findSection(page, 'Missing')).toBeUndefined();
  });

  it('keeps a workflow whose endpoint column is empty and reads labeled metadata', () => {
    const rows = parseWorkflowTable(['| Workflow | Endpoint |', '| - | - |', '| [Text to video](/docs/models/w/x) |  |'].join('\n'));
    expect(rows).toEqual([{ name: 'Text to video', target: '/docs/models/w/x', endpoint: null }]);
    expect(
      extractEndpointMetadata([
        '**Endpoint:** `POST https://api.higgsfield.ai/a/b`',
        '',
        '**Endpoint ID:** `a/b`',
        '',
        '**Catalog ID:** `ignored`'
      ].join('\n'))
    ).toEqual({ endpointUrl: 'https://api.higgsfield.ai/a/b', endpointId: 'a/b' });
  });

  it('reads links in document order and extracts schemas only from the accordion', () => {
    const links = extractLinks('<a href="/docs/models/a">A</a>\n\n[B](/docs/models/b)\n\n[C](https://example.com/c)');
    expect(links.map((link) => link.target)).toEqual(['/docs/models/a', '/docs/models/b', 'https://example.com/c']);

    const page = [
      '```json',
      '{ "decoy": true }',
      '```',
      '',
      '<Accordion title="Complete JSON schema">',
      '  ```json',
      '{ "type": "object", "properties": { "prompt": { "type": "string" } } }',
      '  ```',
      '</Accordion>'
    ].join('\n');
    expect(extractCompleteSchema(page)).toEqual({
      ok: true,
      schema: { type: 'object', properties: { prompt: { type: 'string' } } }
    });
    expect(extractCompleteSchema('no accordion here')).toEqual({ ok: false, reason: 'schema_missing' });
    expect(extractCompleteSchema('<Accordion title="Complete JSON schema">\n```json\n{ oops\n```\n</Accordion>')).toEqual({
      ok: false,
      reason: 'schema_invalid'
    });
  });

  it('rejects non-local or unresolvable schema references', () => {
    expect(schemaReferenceProblem({ $ref: 'https://example.com/s.json' })).toBe('schema_reference_external');
    expect(schemaReferenceProblem({ $ref: '#/$defs/Missing' })).toBe('schema_reference_unresolved');
    expect(
      schemaReferenceProblem({
        $defs: { Style: { type: 'string' } },
        properties: { style: { $ref: '#/$defs/Style' } }
      })
    ).toBeUndefined();
  });

  it('compares schemas structurally, ignoring only descriptive metadata and key order', () => {
    expect(canonicalSchemaJson({ b: 1, a: { title: 'x', default: 2 } })).toBe(
      canonicalSchemaJson({ a: { description: 'y', default: 2 }, b: 1 })
    );
    expect(canonicalSchemaJson({ default: 1 })).not.toBe(canonicalSchemaJson({ default: 2 }));
    expect(canonicalSchemaJson({ enum: ['a'] })).not.toBe(canonicalSchemaJson({ enum: ['b'] }));
    expect(canonicalSchemaJson({ required: ['a'] })).not.toBe(canonicalSchemaJson({ required: [] }));
  });
});

describe('model discovery', () => {
  it('walks category → family → workflow and reports provenance and execution support', async () => {
    const test = harness();
    const { models, catalog } = await test.discovery.list();

    expect(catalog).toMatchObject({
      source: 'official_documentation',
      source_url: `${FIXTURE_DOCS_ORIGIN}/docs/models.md`,
      stale: false,
      fetchedAt: '2026-10-03T00:00:00.000Z',
      total: models.length,
      returned: models.length
    });
    expect(models.map((model) => model.id).sort()).toEqual(
      [
        'alibaba/qwen-image-3/edit',
        'alibaba/qwen-image-3/text-to-image',
        'fixture/drift-model',
        'fixture/preview-model',
        'higgsfield-ai/soul/standard',
        'kling-video/o3/image-reference',
        'kling-video/v2.5-turbo/pro/text-to-video',
        'lightricks/ltx-2.5/fast/text-to-video',
        'pixverse/v6/text-to-video',
        'soul-id',
        'xai/grok-imagine-image-2.0',
        `${FIXTURE_DOCS_ORIGIN}/docs/models/wan-2-6/text-to-video.md`
      ].sort()
    );

    // Category membership, not endpoint-name guessing, decides the media type.
    expect(byId(models, 'xai/grok-imagine-image-2.0').type).toBe('image');
    expect(byId(models, 'kling-video/v2.5-turbo/pro/text-to-video').type).toBe('video');

    const grok = byId(models, 'xai/grok-imagine-image-2.0');
    expect(grok).toMatchObject({
      name: 'Grok Image 2.0 — Generate and edit API',
      endpoint: 'xai/grok-imagine-image-2.0',
      availability: 'documented',
      accountAccess: 'unverified',
      schemaStatus: 'available',
      execution: { supported: true },
      capabilities: ['image_generation', 'image_edit', 'reference_images']
    });
    expect(grok.source.url).toBe(`${FIXTURE_DOCS_ORIGIN}/docs/models/grok-image-2/generate-and-edit.md`);
    expect(grok.source.urls).toEqual([grok.source.url]);
    expect(grok.limits).toBeDefined();

    // The preserved execution identifier for Soul training survives discovery.
    const soul = byId(models, 'soul-id');
    expect(soul.endpoint).toBe('v1/custom-references');
    expect(soul.execution).toEqual({ supported: true });

    // Documented only: kept, marked, and never claimed to be runnable.
    const qwenText = byId(models, 'alibaba/qwen-image-3/text-to-image');
    expect(qwenText.execution).toEqual({ supported: false, reason: 'adapter_not_implemented' });
    expect(qwenText.capabilities).toEqual([]);
    expect(qwenText.source.url).toBe(`${FIXTURE_DOCS_ORIGIN}/docs/models/qwen-image-3/text-to-image.md`);
    expect(qwenText.inputSchema).toEqual({
      type: 'object',
      required: ['prompt'],
      properties: { prompt: { type: 'string', minLength: 1 }, resolution: { enum: ['1k', '2k'] } }
    });
  });

  it('never reads the manifest list as a catalog substitute', async () => {
    const test = harness();
    const { models } = await test.discovery.list();
    // Every manifest entry that is not documented in the fixture directory is absent.
    expect(models.some((model) => model.id === 'bytedance/seedance-2.5/image-to-video')).toBe(false);
    expect(models.some((model) => model.id === 'kling-video/v2.5-turbo/pro/image-to-video')).toBe(false);
  });

  it('reports schema drift, preview origins, unsupported references and unverified endpoints', async () => {
    const { models } = await harness().discovery.list();
    expect(byId(models, 'fixture/drift-model').execution).toEqual({ supported: false, reason: 'schema_changed' });
    expect(byId(models, 'fixture/preview-model').execution).toEqual({
      supported: false,
      reason: 'environment_not_supported'
    });
    const external = byId(models, 'lightricks/ltx-2.5/fast/text-to-video');
    expect(external.schemaStatus).toBe('unavailable');
    expect(external.schemaReason).toBe('schema_reference_external');
    expect(external.execution).toEqual({ supported: false, reason: 'schema_unavailable' });

    const missing = byId(models, 'pixverse/v6/text-to-video');
    expect(missing.schemaStatus).toBe('unavailable');
    expect(missing.schemaReason).toBe('schema_missing');

    // Conflicting table/page endpoint identifiers: kept for provenance, unreliable.
    const conflicted = byId(models, 'kling-video/o3/image-reference');
    expect(conflicted.execution).toEqual({ supported: false, reason: 'endpoint_conflict' });

    // No endpoint anywhere: null endpoint, documented-URL identity, not executable.
    const unverified = models.find((model) => model.id.startsWith(`${FIXTURE_DOCS_ORIGIN}/docs/models/wan-2-6/`));
    expect(unverified).toMatchObject({
      endpoint: null,
      execution: { supported: false, reason: 'endpoint_unverified' },
      name: 'Wan 2.6 — Text to video API'
    });
  });

  it('filters by type, by verified capability and by execution support', async () => {
    const { discovery } = harness();
    const images = await discovery.list({ type: 'image' });
    expect(images.models.every((model) => model.type === 'image')).toBe(true);
    expect(images.models.map((model) => model.id)).toContain('fixture/drift-model');
    expect(images.catalog.returned).toBe(images.models.length);

    const editable = await discovery.list({ capability: 'image_edit' });
    expect(editable.models.map((model) => model.id).sort()).toEqual([
      'alibaba/qwen-image-3/edit',
      'xai/grok-imagine-image-2.0'
    ]);

    const executable = await discovery.list({ executionSupported: true });
    expect(executable.models.map((model) => model.id).sort()).toEqual([
      'alibaba/qwen-image-3/edit',
      'kling-video/v2.5-turbo/pro/text-to-video',
      'soul-id',
      'xai/grok-imagine-image-2.0'
    ]);
    expect(executable.catalog.total).toBeGreaterThan(executable.catalog.returned);

    const notExecutable = await discovery.list({ executionSupported: false });
    expect(notExecutable.models.some((model) => model.execution.supported)).toBe(false);
    expect(notExecutable.models.map((model) => model.id)).toContain('alibaba/qwen-image-3/text-to-image');
  });

  it('returns one model with the same catalog metadata and MODEL_NOT_FOUND for an unknown id', async () => {
    const { discovery } = harness();
    const result = await discovery.get('xai/grok-imagine-image-2.0');
    expect(result.model.id).toBe('xai/grok-imagine-image-2.0');
    expect(result.catalog).toMatchObject({ total: expect.any(Number), returned: 1 });
    await expect(discovery.get('does/not/exist')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      details: { model: 'does/not/exist' }
    });
  });

  it('caches one snapshot, serves both surfaces from it, and picks up newly linked workflows after the TTL', async () => {
    const test = harness();
    const first = await test.discovery.list();
    const indexFetches = test.docs.requests.filter((request) => request.url.endsWith('/docs/models.md')).length;
    expect(indexFetches).toBe(1);

    const second = await test.discovery.list();
    expect(test.docs.requests.filter((request) => request.url.endsWith('/docs/models.md')).length).toBe(1);
    expect(second.catalog.fetchedAt).toBe(first.catalog.fetchedAt);

    // A newly documented workflow is linked into an existing family page: no id list changes.
    const addedUrl = test.docs.addWorkflow({
      type: 'image',
      family: 'qwen-image-3',
      familyTitle: 'Qwen Image 3',
      label: 'Text to image (new)',
      path: 'qwen-image-3/text-to-image-v2',
      listedEndpoint: 'alibaba/qwen-image-3/text-to-image-v2',
      title: 'Qwen Image 3 — Text to image v2 API',
      schema: {
        type: 'object',
        required: ['prompt'],
        properties: { prompt: { type: 'string', minLength: 1 }, aspect_ratio: { enum: ['1:1', '16:9'] } }
      }
    });
    test.advance(DISCOVERY_CACHE_TTL_MS);
    const refreshed = await test.discovery.list();
    const discovered = byId(refreshed.models, 'alibaba/qwen-image-3/text-to-image-v2');
    expect(discovered.source.url).toBe(addedUrl);
    expect(discovered.execution).toEqual({ supported: false, reason: 'adapter_not_implemented' });
    expect(discovered.inputSchema).toEqual({
      type: 'object',
      required: ['prompt'],
      properties: { prompt: { type: 'string', minLength: 1 }, aspect_ratio: { enum: ['1:1', '16:9'] } }
    });
    expect(refreshed.catalog.fetchedAt).not.toBe(first.catalog.fetchedAt);
  });

  it('serves the last complete snapshot with a warning when a refresh fails, and expires it after a day', async () => {
    const test = harness();
    const first = await test.discovery.list();
    test.docs.setOffline(true);
    test.advance(DISCOVERY_CACHE_TTL_MS);
    const stale = await test.discovery.list();
    expect(stale.catalog.stale).toBe(true);
    expect(stale.catalog.fetchedAt).toBe(first.catalog.fetchedAt);
    expect(stale.models.map((model) => model.id)).toEqual(first.models.map((model) => model.id));
    expect(stale.catalog.warnings[0]).toContain('refresh failed');

    test.advance(DISCOVERY_CACHE_TTL_MS + 24 * 60 * 60_000);
    await expect(test.discovery.list()).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: true,
      details: { component: 'model_discovery', reason: 'catalog_unavailable' }
    });
  });

  it('fails an initial crawl instead of serving the bundled models', async () => {
    const test = harness();
    test.docs.setOffline(true);
    await expect(test.discovery.list()).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: true,
      details: { component: 'model_discovery', reason: 'catalog_unavailable' }
    });
  });

  it('invalidates the refresh when a category or family page is unreadable or restructured', async () => {
    const noCategory = harness();
    noCategory.docs.pages.delete('/docs/models/image-generation.md');
    await expect(noCategory.discovery.list()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });

    const restructured = harness();
    restructured.docs.pages.set('/docs/models/grok-image-2.md', '# Grok Image 2.0 API\n\nNo workflows here.\n');
    await expect(restructured.discovery.list()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });

    const noIndex = harness();
    noIndex.docs.pages.set('/docs/models.md', '# Model API Reference\n\n## How the catalog works\n');
    await expect(noIndex.discovery.list()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });

    const emptyTable = harness();
    emptyTable.docs.pages.set(
      '/docs/models/grok-image-2.md',
      '# Grok Image 2.0 API\n\n## Workflows\n\n| Workflow | Endpoint |\n| - | - |\n'
    );
    await expect(emptyTable.discovery.list()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('keeps a workflow whose page cannot be loaded, bounded and with a reason', async () => {
    const workflows: FixtureWorkflowSpec[] = [];
    for (let index = 0; index < DISCOVERY_WARNING_LIMIT + 5; index += 1) {
      workflows.push({
        type: 'video',
        family: 'bulk',
        familyTitle: 'Bulk',
        label: `Workflow ${index}`,
        path: `bulk/workflow-${index}`,
        listedEndpoint: `bulk/workflow-${index}`,
        title: `Bulk — Workflow ${index} API`,
        schema: { type: 'object', properties: { prompt: { type: 'string' } } }
      });
    }
    const docs = createDocsFixture({ workflows });
    for (const spec of workflows) docs.pages.delete(`/docs/models/${spec.path}.md`);
    const { models, catalog } = await harness({ docs }).discovery.list();

    expect(models).toHaveLength(workflows.length);
    expect(models.every((model) => model.schemaStatus === 'unavailable' && model.schemaReason === 'http_status')).toBe(true);
    expect(models.every((model) => model.execution.supported === false)).toBe(true);
    expect(catalog.warnings).toHaveLength(DISCOVERY_WARNING_LIMIT);
    expect(catalog.warnings[DISCOVERY_WARNING_LIMIT - 1]).toContain('suppressed');
  });

  it('merges identical duplicate endpoints and refuses to pick a winner between conflicting ones', async () => {
    const shared: Record<string, unknown> = { type: 'object', properties: { prompt: { type: 'string' } } };
    const workflows: FixtureWorkflowSpec[] = [
      { type: 'image', family: 'dup-a', familyTitle: 'Dup A', label: 'A', path: 'dup-a/a', listedEndpoint: 'dup/identical', title: 'Dup — A API', schema: { ...shared } },
      { type: 'image', family: 'dup-b', familyTitle: 'Dup B', label: 'B', path: 'dup-b/b', listedEndpoint: 'dup/identical', title: 'Dup — A API', schema: { ...shared } },
      { type: 'image', family: 'dup-c', familyTitle: 'Dup C', label: 'C', path: 'dup-c/c', listedEndpoint: 'dup/conflicting', title: 'Dup — C API', schema: { ...shared } },
      {
        type: 'image',
        family: 'dup-d',
        familyTitle: 'Dup D',
        label: 'D',
        path: 'dup-d/d',
        listedEndpoint: 'dup/conflicting',
        title: 'Dup — D API',
        schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } }
      }
    ];
    const { models, catalog } = await harness({ workflows }).discovery.list();

    const identical = byId(models, 'dup/identical');
    expect(identical.source.urls).toEqual([
      `${FIXTURE_DOCS_ORIGIN}/docs/models/dup-a/a.md`,
      `${FIXTURE_DOCS_ORIGIN}/docs/models/dup-b/b.md`
    ]);
    expect(models.filter((model) => model.id === 'dup/identical')).toHaveLength(1);

    const conflicting = byId(models, 'dup/conflicting');
    expect(models.filter((model) => model.id === 'dup/conflicting')).toHaveLength(1);
    expect(conflicting.execution).toEqual({ supported: false, reason: 'endpoint_conflict' });
    expect(conflicting.source.urls).toHaveLength(2);
    expect(catalog.warnings.some((warning) => warning.includes('dup/conflicting'))).toBe(true);
  });

  it('refreshes once for concurrent discovery calls and touches no other host', async () => {
    const test = harness();
    const [first, second, third] = await Promise.all([
      test.discovery.list(),
      test.discovery.list(),
      test.discovery.list()
    ]);
    expect(test.docs.requests.filter((request) => request.url.endsWith('/docs/models.md')).length).toBe(1);
    expect(first.catalog.fetchedAt).toBe(second.catalog.fetchedAt);
    expect(second.catalog.fetchedAt).toBe(third.catalog.fetchedAt);

    for (const request of test.docs.requests) {
      expect(request.url.startsWith(`${FIXTURE_DOCS_ORIGIN}/docs/models`)).toBe(true);
      expect(Object.keys(request.headers)).not.toContain('authorization');
    }
    // Related topics, playground cards and category-grid extras are never crawled.
    expect(test.docs.requests.some((request) => request.url.includes('example.com'))).toBe(false);
    expect(test.docs.requests.some((request) => request.url.includes('console.higgsfield.ai'))).toBe(false);
    expect(test.docs.requests.some((request) => request.url.includes('/docs/models/grok-image-2.md'))).toBe(true);
  });

  it('fails the refresh when a page exceeds the response budget', async () => {
    const test = harness({ maxResponseBytes: 64 });
    await expect(test.discovery.list()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});
