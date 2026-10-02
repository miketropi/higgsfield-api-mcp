/**
 * Live model discovery over the provider's public documentation directory.
 *
 * Discovery answers a different question than the execution manifest: what does the
 * provider document *right now*? It walks the documented directory — Model API
 * Reference index → model category → model family → workflow — and republishes every
 * documented workflow, including the ones this gateway cannot run. Nothing here
 * enables a provider endpoint: `execution.supported` is advice, and native generation
 * still has to pass the adapter's own allowlist.
 *
 * The walk is resumable only as a whole: one immutable snapshot per crawl, cached for
 * ten minutes, refreshed single-flight, and served stale (with a warning) for up to a
 * day after a refresh failure. A partially read directory is never published.
 */
import type {
  CatalogMetadata,
  Clock,
  DiscoveredModel,
  DiscoveredModelResult,
  DiscoveredCatalog,
  DiscoveryExecution,
  DiscoveryFilter,
  LoggerPort,
  ModelDefinition,
  ModelDiscovery,
  ModelRegistry,
  ModelType
} from '@higgsfield-mcp/core';
import { GatewayError } from '@higgsfield-mcp/core';
import type { HiggsfieldFetch } from '../client/http.js';
import { isEndpointId } from '../paths.js';
import {
  DOCUMENTATION_INDEX_URL,
  canonicalDocumentationUrl,
  createDocumentationFetcher,
  DocumentationFetchError,
  type DocumentationFetcher,
  type DocumentationFetchLimits
} from './docs-fetch.js';
import {
  canonicalSchemaJson,
  extractCompleteSchema,
  extractEndpointMetadata,
  extractLinks,
  findSection,
  firstHeadingTitle,
  parseWorkflowTable,
  schemaReferenceProblem
} from './docs-parse.js';

/** Snapshot lifetime before a discovery call refreshes it. */
export const DISCOVERY_CACHE_TTL_MS = 10 * 60_000;
/** How long a complete snapshot may be served after refresh failures begin. */
export const DISCOVERY_STALE_MAX_AGE_MS = 24 * 60 * 60_000;
/** Maximum warnings published per catalog metadata block. */
export const DISCOVERY_WARNING_LIMIT = 20;
/** Concurrent documentation requests. */
export const DISCOVERY_CONCURRENCY = 4;
/** Documented production origin of the provider API. */
export const DISCOVERY_PRODUCTION_HOST = 'api.higgsfield.ai';

const CATEGORY_TYPES: readonly { readonly slug: string; readonly type: ModelType }[] = [
  { slug: 'image', type: 'image' },
  { slug: 'video', type: 'video' },
  { slug: 'audio', type: 'audio' },
  { slug: '3d', type: '3d' }
];

/** Internal, body-free reason for a refresh that must invalidate the catalog. */
class CatalogRefreshError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Model discovery refresh failed: ${reason}.`);
    this.name = 'CatalogRefreshError';
    this.reason = reason;
  }
}

export interface ModelDiscoveryOptions {
  /** Execution manifest: the only endpoints this gateway may run. */
  manifest: ModelRegistry;
  /** Injected transport for documentation requests. */
  fetch?: HiggsfieldFetch | undefined;
  /** Injected time source; snapshot ages are measured against it. */
  clock?: Clock | undefined;
  logger?: LoggerPort | undefined;
  limits?: Partial<DocumentationFetchLimits> | undefined;
}

/** One documented workflow, collected from the crawler before manifest projection. */
interface WorkflowSource {
  type: ModelType;
  /** Workflow page (or family page for a documented leaf). */
  url: string;
  /** Documented workflow label from the family listing, as a name fallback. */
  listedName: string;
  /** Endpoint id declared by the family listing, or `null` when it declares none. */
  listedEndpoint: string | null;
}

/** A discovered workflow projected onto the execution manifest. */
interface Assembled {
  id: string;
  name: string;
  type: ModelType;
  endpoint: string | null;
  capabilities: string[];
  limits?: ModelDefinition['limits'] | undefined;
  pricing?: ModelDefinition['pricing'] | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  schemaStatus: DiscoveredModel['schemaStatus'];
  schemaReason?: string | undefined;
  schemaCanonical?: string | undefined;
  execution: DiscoveryExecution;
  urls: string[];
}

interface Snapshot {
  models: readonly DiscoveredModel[];
  fetchedAt: string;
  fetchedAtMs: number;
  warnings: readonly string[];
}

function pageTitle(markdown: string | undefined, fallback: string): string {
  if (markdown === undefined) return fallback;
  return firstHeadingTitle(markdown) ?? fallback;
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T);
    }
  };
  const workers: Promise<void>[] = [];
  for (let started = 0; started < Math.min(limit, items.length); started += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function categoryType(url: string): ModelType | undefined {
  const slug = (new URL(url).pathname.split('/').at(-1) ?? '').replace(/\.md$/, '').toLowerCase();
  return CATEGORY_TYPES.find((entry) => slug.includes(entry.slug))?.type;
}

/** Canonical documentation links found in `section`, in document order, deduplicated. */
function sectionLinks(section: string, base: string): string[] {
  const urls: string[] = [];
  for (const link of extractLinks(section)) {
    const canonical = canonicalDocumentationUrl(link.target, base);
    if (canonical !== undefined && !urls.includes(canonical)) urls.push(canonical);
  }
  return urls;
}

/** The endpoint id a documented endpoint URL addresses, plus its origin class. */
function endpointFromUrl(url: string | undefined): { id?: string | undefined; production: boolean } | undefined {
  if (url === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  const id = parsed.pathname.replace(/^\//, '').replace(/\/$/, '');
  return {
    ...(isEndpointId(id) ? { id } : {}),
    production: parsed.hostname === DISCOVERY_PRODUCTION_HOST
  };
}

async function collectWorkflows(fetcher: DocumentationFetcher): Promise<WorkflowSource[]> {
  const index = await fetcher.fetchPage(DOCUMENTATION_INDEX_URL);
  const categorySection = findSection(index, 'Choose a model category');
  if (categorySection === undefined) throw new CatalogRefreshError('index_section_missing');
  const categoryUrls = sectionLinks(categorySection, DOCUMENTATION_INDEX_URL);
  if (categoryUrls.length === 0) throw new CatalogRefreshError('index_categories_missing');

  const categories = await mapConcurrent(categoryUrls, DISCOVERY_CONCURRENCY, async (url) => {
    const type = categoryType(url);
    if (type === undefined) throw new CatalogRefreshError('category_type_unknown');
    const body = await fetcher.fetchPage(url);
    const modelsSection = findSection(body, 'Models');
    if (modelsSection === undefined) throw new CatalogRefreshError('category_section_missing');
    const familyUrls = sectionLinks(modelsSection, url);
    if (familyUrls.length === 0) throw new CatalogRefreshError('category_families_missing');
    return { type, familyUrls };
  });

  const families = categories.flatMap((category) =>
    category.familyUrls.map((url) => ({ type: category.type, url }))
  );

  const collected = await mapConcurrent(families, DISCOVERY_CONCURRENCY, async (family) => {
    const body = await fetcher.fetchPage(family.url);
    const metadata = extractEndpointMetadata(body);
    // A family page that labels its own endpoint *is* the workflow: there is no
    // further level to walk, and the page's own metadata is the provenance.
    if (metadata.endpointId !== undefined || metadata.endpointUrl !== undefined) {
      return [
        { type: family.type, url: family.url, listedName: pageTitle(body, family.url), listedEndpoint: null } satisfies WorkflowSource
      ];
    }
    const workflows = findSection(body, 'Workflows');
    if (workflows === undefined) throw new CatalogRefreshError('family_section_missing');
    const rows = parseWorkflowTable(workflows);
    if (rows.length === 0) throw new CatalogRefreshError('family_workflows_empty');
    return rows.map((row) => {
      const url = canonicalDocumentationUrl(row.target, family.url);
      if (url === undefined) throw new CatalogRefreshError('workflow_link_not_documentation');
      return {
        type: family.type,
        url,
        listedName: row.name,
        listedEndpoint: row.endpoint
      } satisfies WorkflowSource;
    });
  });

  const seen = new Set<string>();
  const workflows: WorkflowSource[] = [];
  for (const source of collected.flat()) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    workflows.push(source);
  }
  if (workflows.length === 0) throw new CatalogRefreshError('directory_empty');
  return workflows;
}

interface ManifestIndex {
  byEndpoint: ReadonlyMap<string, ModelDefinition>;
  publicIdByEndpoint: ReadonlyMap<string, string>;
}

function manifestIndex(manifest: ModelRegistry): ManifestIndex {
  const byEndpoint = new Map<string, ModelDefinition>();
  const publicIdByEndpoint = new Map<string, string>();
  for (const model of manifest.list()) {
    byEndpoint.set(model.endpoint, model);
    // The one documented identity mapping: Soul training is published as `soul-id`
    // while its endpoint is `v1/custom-references` (SPEC §19).
    if (model.id !== model.endpoint) publicIdByEndpoint.set(model.endpoint, model.id);
  }
  return { byEndpoint, publicIdByEndpoint };
}

function executionFor(assembled: {
  endpoint: string | null;
  conflicted: boolean;
  manifestModel: ModelDefinition | undefined;
  production: boolean;
  schemaStatus: DiscoveredModel['schemaStatus'];
  schemaMatches: boolean;
}): DiscoveryExecution {
  if (assembled.endpoint === null) return { supported: false, reason: 'endpoint_unverified' };
  if (assembled.conflicted) return { supported: false, reason: 'endpoint_conflict' };
  if (assembled.manifestModel === undefined) return { supported: false, reason: 'adapter_not_implemented' };
  if (!assembled.production) return { supported: false, reason: 'environment_not_supported' };
  if (assembled.schemaStatus !== 'available') return { supported: false, reason: 'schema_unavailable' };
  if (!assembled.schemaMatches) return { supported: false, reason: 'schema_changed' };
  return { supported: true };
}

async function assembleWorkflow(
  fetcher: DocumentationFetcher,
  source: WorkflowSource,
  index: ManifestIndex
): Promise<{ assembled: Assembled; warning?: string }> {
  let body: string | undefined;
  let pageFailure: string | undefined;
  try {
    body = await fetcher.fetchPage(source.url);
  } catch (error) {
    pageFailure = error instanceof DocumentationFetchError ? error.reason : 'unreadable';
  }

  const metadata = body === undefined ? {} : extractEndpointMetadata(body);
  const pageEndpoint = metadata.endpointId !== undefined && isEndpointId(metadata.endpointId) ? metadata.endpointId : undefined;
  const urlEndpoint = endpointFromUrl(metadata.endpointUrl);
  const listed =
    source.listedEndpoint !== null && isEndpointId(source.listedEndpoint) ? source.listedEndpoint : undefined;
  const declared = [listed, pageEndpoint, urlEndpoint?.id].filter((value): value is string => value !== undefined);
  const conflicted = new Set(declared).size > 1;
  const endpoint = declared[0] ?? null;
  const production = urlEndpoint?.production ?? true;

  let schemaStatus: DiscoveredModel['schemaStatus'] = 'unavailable';
  let schemaReason: string | undefined = pageFailure ?? 'schema_missing';
  let schema: Record<string, unknown> | undefined;
  let schemaCanonical: string | undefined;
  if (body !== undefined) {
    const extracted = extractCompleteSchema(body);
    if (!extracted.ok) {
      schemaReason = extracted.reason;
    } else {
      const problem = schemaReferenceProblem(extracted.schema);
      if (problem !== undefined) {
        schemaReason = problem;
      } else {
        schemaStatus = 'available';
        schemaReason = undefined;
        schema = extracted.schema;
        schemaCanonical = canonicalSchemaJson(extracted.schema);
      }
    }
  }

  const manifestModel = endpoint === null ? undefined : index.byEndpoint.get(endpoint);
  const schemaMatches =
    manifestModel?.inputSchema !== undefined && schemaCanonical !== undefined
      ? canonicalSchemaJson(manifestModel.inputSchema) === schemaCanonical
      : false;

  const assembled: Assembled = {
    id: endpoint === null ? source.url : index.publicIdByEndpoint.get(endpoint) ?? endpoint,
    name: pageTitle(body, source.listedName),
    type: source.type,
    endpoint,
    // Capabilities come from the execution manifest or not at all: a name or a schema
    // field is not evidence that a semantic mapping exists.
    capabilities: manifestModel === undefined ? [] : [...manifestModel.capabilities],
    ...(manifestModel === undefined ? {} : { limits: manifestModel.limits }),
    ...(manifestModel?.pricing === undefined ? {} : { pricing: manifestModel.pricing }),
    ...(schema === undefined ? {} : { inputSchema: schema }),
    schemaStatus,
    ...(schemaReason === undefined ? {} : { schemaReason }),
    ...(schemaCanonical === undefined ? {} : { schemaCanonical }),
    execution: executionFor({ endpoint, conflicted, manifestModel, production, schemaStatus, schemaMatches }),
    urls: [source.url]
  };
  return pageFailure === undefined
    ? { assembled }
    : { assembled, warning: `A workflow page could not be read (${source.url}); its schema is unavailable.` };
}

/**
 * Folds records that share one endpoint: identical documentation merges provenance,
 * anything that disagrees is kept once and marked not executable. Merging keeps ids
 * unique and keeps the disagreement visible instead of picking a winner silently.
 */
function mergeDuplicates(assembled: readonly Assembled[], warnings: string[]): Assembled[] {
  const byEndpoint = new Map<string, Assembled[]>();
  const ordered: Assembled[] = [];
  for (const entry of assembled) {
    if (entry.endpoint === null) {
      ordered.push(entry);
      continue;
    }
    const group = byEndpoint.get(entry.endpoint);
    if (group === undefined) {
      byEndpoint.set(entry.endpoint, [entry]);
      ordered.push(entry);
      continue;
    }
    const first = group[0] as Assembled;
    for (const url of entry.urls) if (!first.urls.includes(url)) first.urls.push(url);
    const identical =
      first.name === entry.name &&
      first.type === entry.type &&
      first.schemaCanonical === entry.schemaCanonical &&
      first.schemaStatus === entry.schemaStatus;
    if (identical) continue;
    first.execution = { supported: false, reason: 'endpoint_conflict' };
    warnings.push(`Documentation disagrees with itself about endpoint ${entry.endpoint}; marking it not executable.`);
  }
  return ordered;
}

function boundWarnings(warnings: readonly string[]): string[] {
  if (warnings.length <= DISCOVERY_WARNING_LIMIT) return [...warnings];
  const kept = warnings.slice(0, DISCOVERY_WARNING_LIMIT - 1);
  kept.push(`${warnings.length - kept.length} further discovery warnings were suppressed.`);
  return kept;
}

function freezeRecord(record: Assembled, fetchedAt: string): DiscoveredModel {
  const model: DiscoveredModel = {
    id: record.id,
    name: record.name,
    type: record.type,
    endpoint: record.endpoint,
    capabilities: record.capabilities,
    ...(record.inputSchema === undefined ? {} : { inputSchema: record.inputSchema }),
    ...(record.limits === undefined ? {} : { limits: record.limits }),
    ...(record.pricing === undefined ? {} : { pricing: record.pricing }),
    schemaStatus: record.schemaStatus,
    ...(record.schemaReason === undefined ? {} : { schemaReason: record.schemaReason }),
    availability: 'documented',
    accountAccess: 'unverified',
    execution: record.execution,
    source: { url: record.urls[0] as string, urls: [...record.urls], fetchedAt }
  };
  return deepFreeze(model);
}

function deepFreeze<T>(value: T, depth = 0): T {
  if (depth > 12 || typeof value !== 'object' || value === null) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, depth + 1);
  return Object.freeze(value);
}

export function createModelDiscovery(options: ModelDiscoveryOptions): ModelDiscovery {
  const clock = options.clock ?? { now: () => new Date() };
  const logger = options.logger;
  const index = manifestIndex(options.manifest);

  let snapshot: Snapshot | undefined;
  let refresh: Promise<Snapshot> | undefined;

  const runRefresh = async (): Promise<Snapshot> => {
    const fetcher = createDocumentationFetcher({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.limits === undefined ? {} : { limits: options.limits })
    });
    const startedAt = clock.now();
    // Every record is stamped with the snapshot's fetch time: one crawl is one
    // generation, and a cached snapshot keeps the timestamp it was fetched at.
    const fetchedAt = startedAt.toISOString();
    const sources = await collectWorkflows(fetcher);
    const warnings: string[] = [];
    const assemblies = await mapConcurrent(sources, DISCOVERY_CONCURRENCY, (source) =>
      assembleWorkflow(fetcher, source, index)
    );
    for (const entry of assemblies) if (entry.warning !== undefined) warnings.push(entry.warning);
    const merged = mergeDuplicates(
      assemblies.map((entry) => entry.assembled),
      warnings
    );
    const records = merged
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .map((entry) => freezeRecord(entry, fetchedAt));
    return {
      models: Object.freeze(records),
      fetchedAt,
      fetchedAtMs: startedAt.getTime(),
      warnings: Object.freeze(boundWarnings(warnings))
    };
  };

  const refreshSnapshot = (): Promise<Snapshot> => {
    if (refresh !== undefined) return refresh;
    const started = runRefresh().then((built) => {
      snapshot = built;
      return built;
    });
    refresh = started;
    const done = (): void => {
      if (refresh === started) refresh = undefined;
    };
    started.then(done, done);
    return started;
  };

  const current = async (): Promise<{ snapshot: Snapshot; stale: boolean; warnings: readonly string[] }> => {
    const ageMs = (): number => (snapshot === undefined ? Number.POSITIVE_INFINITY : clock.now().getTime() - snapshot.fetchedAtMs);
    if (snapshot !== undefined && ageMs() < DISCOVERY_CACHE_TTL_MS) {
      return { snapshot, stale: false, warnings: snapshot.warnings };
    }
    try {
      const fresh = await refreshSnapshot();
      return { snapshot: fresh, stale: false, warnings: fresh.warnings };
    } catch (error) {
      const reason =
        error instanceof DocumentationFetchError || error instanceof CatalogRefreshError ? error.reason : 'unexpected';
      logger?.warn(
        { event: 'discovery.refresh_failed', reason, staleSnapshotAvailable: snapshot !== undefined },
        'Model discovery refresh failed'
      );
      if (snapshot !== undefined && ageMs() < DISCOVERY_STALE_MAX_AGE_MS) {
        return {
          snapshot,
          stale: true,
          warnings: boundWarnings([
            'Documentation refresh failed; serving the last complete catalog snapshot.',
            ...snapshot.warnings
          ])
        };
      }
      throw new GatewayError('PROVIDER_ERROR', 'The provider documentation catalog is unavailable.', {
        details: { component: 'model_discovery', reason: 'catalog_unavailable' },
        cause: error
      });
    }
  };

  const metadataFor = (state: { snapshot: Snapshot; stale: boolean; warnings: readonly string[] }, returned: number): CatalogMetadata => ({
    source: 'official_documentation',
    sourceUrl: DOCUMENTATION_INDEX_URL,
    fetchedAt: state.snapshot.fetchedAt,
    stale: state.stale,
    total: state.snapshot.models.length,
    returned,
    warnings: [...state.warnings]
  });

  const matches = (model: DiscoveredModel, filter: DiscoveryFilter | undefined): boolean => {
    if (filter?.type !== undefined && model.type !== filter.type) return false;
    if (filter?.capability !== undefined && !model.capabilities.includes(filter.capability)) return false;
    if (filter?.executionSupported !== undefined && model.execution.supported !== filter.executionSupported) return false;
    return true;
  };

  return {
    async list(filter?: DiscoveryFilter): Promise<DiscoveredCatalog> {
      const state = await current();
      const models = state.snapshot.models.filter((model) => matches(model, filter));
      return { models, catalog: metadataFor(state, models.length) };
    },

    async get(id: string): Promise<DiscoveredModelResult> {
      const state = await current();
      const model = state.snapshot.models.find((entry) => entry.id === id);
      if (model === undefined) {
        throw new GatewayError('MODEL_NOT_FOUND', `Unknown model: ${id}.`, { details: { model: id } });
      }
      return { model, catalog: metadataFor(state, 1) };
    }
  };
}
