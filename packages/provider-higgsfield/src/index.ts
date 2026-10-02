/**
 * Public surface of `@higgsfield-mcp/provider-higgsfield`.
 *
 * The app composition layer needs exactly four things: the provider (and its
 * factory), the HTTP client, the bundled model catalog, and the pure translation
 * helpers. Internal modules are re-exported by name — never with `export *` — so
 * nothing leaks by accident.
 */
export { HIGGSFIELD_ADAPTER_VERSION, HIGGSFIELD_CATALOG_VERSION, HIGGSFIELD_PROVIDER_ID } from './version.js';

export {
  HIGGSFIELD_API_BASE_URL,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  HiggsfieldHttpClient
} from './client/http.js';
export type {
  HiggsfieldFetch,
  HiggsfieldFetchResponse,
  HiggsfieldHttpClientOptions,
  HiggsfieldHttpResponse,
  HiggsfieldJsonPostOptions,
  HiggsfieldJsonRequestOptions,
  HiggsfieldPutOptions
} from './client/http.js';

export {
  ProviderHttpError,
  extractProviderDetail,
  mapProviderHttpError,
  mapProviderTransportError,
  parseRetryAfterMs,
  sanitizeProviderMessage
} from './errors.js';
export type { ProviderHttpErrorContext, ProviderOperation } from './errors.js';

export {
  DOCUMENTED_CUSTOM_REFERENCE_STATUSES,
  DOCUMENTED_REQUEST_STATUSES,
  mapCustomReferenceStatus,
  mapProviderStatus,
  microUsdToUsd,
  parseUsdToMicroUsd,
  toProviderFailure
} from './mapping.js';
export type {
  DocumentedCustomReferenceStatus,
  DocumentedRequestStatus,
  MappedProviderStatus,
  ProviderFailureInput
} from './mapping.js';

export {
  assertAbsoluteHttpUrl,
  assertAllowedProviderPath,
  assertSafePathSegment,
  encodeEndpointId,
  encodePathSegment,
  isAllowedProviderPath,
  isBlockedHostAddress,
  isBlockedHostname,
  isEndpointId,
  isFixedProviderPath,
  isModelEndpointPath,
  isSafePathSegment,
  isUsableHttpUrl
} from './paths.js';

export {
  findModelDefinition,
  getCatalogMetadata,
  getDocumentedDefaults,
  getModelDefinition,
  getUnavailableModels,
  getUploadContentTypes,
  getUploadUrlTtlSeconds,
  loadBundledCatalog,
  validateCatalogRegistry
} from './models/catalog.js';
export type {
  HiggsfieldCatalogMetadata,
  UnavailableModelEntry,
  ValidatedCatalogRegistry
} from './models/catalog.js';

export {
  DISCOVERY_CACHE_TTL_MS,
  DISCOVERY_CONCURRENCY,
  DISCOVERY_PRODUCTION_HOST,
  DISCOVERY_STALE_MAX_AGE_MS,
  DISCOVERY_WARNING_LIMIT,
  createModelDiscovery
} from './models/discovery.js';
export type { ModelDiscoveryOptions } from './models/discovery.js';

export {
  DEFAULT_DOCUMENTATION_FETCH_LIMITS,
  DOCUMENTATION_INDEX_URL,
  DOCUMENTATION_ORIGIN,
  DOCUMENTATION_PATH_PREFIX,
  DocumentationFetchError,
  canonicalDocumentationUrl,
  createDocumentationFetcher,
  isAllowedDocumentationUrl
} from './models/docs-fetch.js';
export type {
  DocumentationFetchFailure,
  DocumentationFetcher,
  DocumentationFetcherOptions,
  DocumentationFetchLimits
} from './models/docs-fetch.js';

export {
  canonicalSchemaJson,
  extractCompleteSchema,
  extractEndpointMetadata,
  extractLinks,
  findSection,
  firstHeadingTitle,
  parseWorkflowTable,
  schemaReferenceProblem
} from './models/docs-parse.js';
export type { DocumentedLink, EndpointMetadata, SchemaExtraction, WorkflowTableRow } from './models/docs-parse.js';

export { cloneJsonValue, isRecord, validateAgainstJsonSchema } from './models/validate.js';
export type { SchemaValidationIssue } from './models/validate.js';

export {
  CUSTOM_REFERENCE_HANDLE_PREFIX,
  GENERATION_HANDLE_PREFIX,
  HiggsfieldProvider,
  buildModelRequestBody,
  createHiggsfieldProviderFactory,
  parseProviderJobHandle,
  toCustomReferenceSnapshot,
  toGenerationStatusSnapshot,
  toGenerationSubmissionSnapshot
} from './provider.js';
export type {
  HiggsfieldProviderFactoryOptions,
  HiggsfieldProviderOptions,
  ProviderJobHandle
} from './provider.js';

export { credentialKeyId, toAuthorizationValue } from './credentials.js';
