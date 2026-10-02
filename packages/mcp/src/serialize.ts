import type {
  CatalogMetadata,
  DiscoveredModel,
  DiscoveredModelResult,
  MediaAsset,
  PricingDefinition,
  StructuredError
} from '@higgsfield-mcp/core';
import { microUsdToUsd, toStructuredError } from '@higgsfield-mcp/core';
import { z } from 'zod';

/**
 * Frozen MCP wire contract (snake_case). Internal models are camelCase; this module
 * is the only place the translation happens, and it never emits tenant ids,
 * submission state, storage keys, origins or credentials.
 */

export const assetSchema = z.object({
  asset_id: z.string(),
  url: z.string(),
  media_type: z.string(),
  mime_type: z.string(),
  size: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration_seconds: z.number().optional(),
  created_at: z.string(),
  expires_at: z.string().optional()
});

export const costSchema = z.object({
  currency: z.literal('USD'),
  estimated_cost_usd: z.number().optional(),
  actual_cost_usd: z.number().optional(),
  source: z.string()
});

export const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  retry_after_ms: z.number().optional(),
  details: z.record(z.string(), z.unknown()).optional()
});

export const jobSchema = z.object({
  job_id: z.string(),
  status: z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']),
  provider: z.string(),
  provider_job_id: z.string().optional(),
  capability: z.string(),
  model: z.string().optional(),
  endpoint: z.string().optional(),
  workspace_id: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  input_summary: z.record(z.string(), z.unknown()),
  assets: z.array(assetSchema),
  cost: costSchema.optional(),
  error: errorSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const pricingSchema = z.object({
  currency: z.literal('USD'),
  unit_micro_usd: z.number().optional(),
  per_second_micro_usd: z.number().optional(),
  source: z.string(),
  as_of: z.string()
});

/**
 * Discovery wire contract. A discovered record is not an execution definition: it
 * carries documentation provenance, an explicit schema state and an explicit
 * `execution.supported` verdict instead of a status the gateway cannot honor.
 */
export const discoverySourceSchema = z.object({
  url: z.string(),
  urls: z.array(z.string()),
  fetched_at: z.string()
});

export const discoveryExecutionSchema = z.object({
  supported: z.boolean(),
  reason: z.string().optional()
});

export const catalogSchema = z.object({
  source: z.literal('official_documentation'),
  source_url: z.string(),
  fetched_at: z.string(),
  stale: z.boolean(),
  total: z.number(),
  returned: z.number(),
  warnings: z.array(z.string())
});

export const discoveredModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['image', 'video', 'audio', '3d']),
  availability: z.literal('documented'),
  account_access: z.literal('unverified'),
  endpoint: z.string().nullable(),
  capabilities: z.array(z.string()),
  schema_status: z.enum(['available', 'unavailable']),
  schema_reason: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
  pricing: pricingSchema.optional(),
  execution: discoveryExecutionSchema,
  source: discoverySourceSchema
});

export const discoveredModelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['image', 'video', 'audio', '3d']),
  availability: z.literal('documented'),
  account_access: z.literal('unverified'),
  endpoint: z.string().nullable(),
  capabilities: z.array(z.string()),
  schema_status: z.enum(['available', 'unavailable']),
  execution: discoveryExecutionSchema
});

export const discoveredCatalogSchema = z.object({
  models: z.array(discoveredModelSummarySchema),
  catalog: catalogSchema
});

export const discoveredModelResultSchema = discoveredModelSchema.extend({ catalog: catalogSchema });

export const capabilitiesSchema = z.object({
  gateway_version: z.string(),
  mcp_protocol: z.string(),
  provider: z.object({ id: z.string(), version: z.string() }),
  skills_version: z.string(),
  capabilities: z.array(z.string()),
  tools: z.object({ count: z.number(), names: z.array(z.string()) }),
  auth: z.object({ mode: z.string(), scopes: z.array(z.string()) }),
  limits: z.object({
    max_wait_ms: z.number(),
    max_image_jobs: z.number(),
    max_video_jobs: z.number()
  })
});

export const confirmationSchema = z.object({
  status: z.literal('confirmation_required'),
  estimated_cost_usd: z.number(),
  confirmation_token: z.string(),
  expires_at: z.string()
});

export type WireJob = z.infer<typeof jobSchema>;
export type WireAsset = z.infer<typeof assetSchema>;
export type WireDiscoveredModel = z.infer<typeof discoveredModelSchema>;
export type WireDiscoveredSummary = z.infer<typeof discoveredModelSummarySchema>;
export type WireCatalog = z.infer<typeof catalogSchema>;
export type WireError = z.infer<typeof errorSchema>;
export type WireCapabilities = z.infer<typeof capabilitiesSchema>;

export function serializeAsset(asset: MediaAsset): WireAsset {
  const wire: WireAsset = {
    asset_id: asset.id,
    url: asset.url,
    media_type: asset.mediaType,
    mime_type: asset.mimeType,
    created_at: asset.createdAt
  };
  if (asset.size !== undefined) wire.size = asset.size;
  if (asset.width !== undefined) wire.width = asset.width;
  if (asset.height !== undefined) wire.height = asset.height;
  if (asset.durationSeconds !== undefined) wire.duration_seconds = asset.durationSeconds;
  if (asset.urlExpiresAt !== undefined) wire.expires_at = asset.urlExpiresAt;
  return wire;
}

export function serializeJob(job: GenerationJobLike): WireJob {
  const wire: WireJob = {
    job_id: job.id,
    status: job.status,
    provider: job.provider,
    capability: job.capability,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    input_summary: job.inputSummary,
    assets: job.assets.map(serializeAsset)
  };
  if (job.providerJobId !== undefined) wire.provider_job_id = job.providerJobId;
  if (job.model !== undefined) wire.model = job.model;
  if (job.endpoint !== undefined) wire.endpoint = job.endpoint;
  if (job.workspaceId !== undefined) wire.workspace_id = job.workspaceId;
  if (job.cost !== undefined) {
    const cost: WireJob['cost'] = { currency: 'USD', source: job.cost.source };
    if (job.cost.estimatedMicroUsd !== undefined) cost.estimated_cost_usd = microUsdToUsd(job.cost.estimatedMicroUsd);
    if (job.cost.actualMicroUsd !== undefined) cost.actual_cost_usd = microUsdToUsd(job.cost.actualMicroUsd);
    wire.cost = cost;
  }
  if (job.error !== undefined) wire.error = serializeError(job.error);
  if (job.metadata !== undefined) wire.metadata = job.metadata;
  return wire;
}

interface GenerationJobLike {
  id: string;
  status: WireJob['status'];
  provider: string;
  providerJobId?: string | undefined;
  capability: string;
  model?: string | undefined;
  endpoint?: string | undefined;
  workspaceId?: string | undefined;
  createdAt: string;
  updatedAt: string;
  inputSummary: Record<string, unknown>;
  assets: MediaAsset[];
  cost?: { currency: 'USD'; estimatedMicroUsd?: number | undefined; actualMicroUsd?: number | undefined; source: string } | undefined;
  error?: StructuredError | undefined;
  metadata?: Record<string, unknown> | undefined;
}

function wirePricing(pricing: PricingDefinition): z.infer<typeof pricingSchema> {
  return {
    currency: 'USD',
    source: pricing.source,
    as_of: pricing.asOf,
    ...(pricing.unitMicroUsd === undefined ? {} : { unit_micro_usd: pricing.unitMicroUsd }),
    ...(pricing.perSecondMicroUsd === undefined ? {} : { per_second_micro_usd: pricing.perSecondMicroUsd })
  };
}

export function serializeCatalog(catalog: CatalogMetadata): WireCatalog {
  return {
    source: catalog.source,
    source_url: catalog.sourceUrl,
    fetched_at: catalog.fetchedAt,
    stale: catalog.stale,
    total: catalog.total,
    returned: catalog.returned,
    warnings: [...catalog.warnings]
  };
}

/** Full discovered record: endpoint, schema state, execution verdict and provenance. */
export function serializeDiscoveredModel(model: DiscoveredModel): WireDiscoveredModel {
  const wire: WireDiscoveredModel = {
    id: model.id,
    name: model.name,
    type: model.type,
    availability: model.availability,
    account_access: model.accountAccess,
    endpoint: model.endpoint,
    capabilities: [...model.capabilities],
    schema_status: model.schemaStatus,
    execution: {
      supported: model.execution.supported,
      ...(model.execution.reason === undefined ? {} : { reason: model.execution.reason })
    },
    source: { url: model.source.url, urls: [...model.source.urls], fetched_at: model.source.fetchedAt }
  };
  if (model.schemaReason !== undefined) wire.schema_reason = model.schemaReason;
  if (model.inputSchema !== undefined) wire.input_schema = model.inputSchema;
  if (model.limits !== undefined) wire.limits = model.limits as Record<string, unknown>;
  if (model.pricing !== undefined) wire.pricing = wirePricing(model.pricing);
  return wire;
}

/** Listing shape: enough to choose a model without fetching every schema. */
export function serializeDiscoveredSummary(model: DiscoveredModel): WireDiscoveredSummary {
  return {
    id: model.id,
    name: model.name,
    type: model.type,
    availability: model.availability,
    account_access: model.accountAccess,
    endpoint: model.endpoint,
    capabilities: [...model.capabilities],
    schema_status: model.schemaStatus,
    execution: {
      supported: model.execution.supported,
      ...(model.execution.reason === undefined ? {} : { reason: model.execution.reason })
    }
  };
}

/** `models.get` flattens the record and the snapshot metadata into one object. */
export function serializeDiscoveredResult(result: DiscoveredModelResult): WireDiscoveredModel & { catalog: WireCatalog } {
  return { ...serializeDiscoveredModel(result.model), catalog: serializeCatalog(result.catalog) };
}

export function serializeError(error: unknown): WireError {
  const structured = toStructuredError(error);
  const wire: WireError = { code: structured.code, message: structured.message, retryable: structured.retryable };
  if (structured.retryAfterMs !== undefined) wire.retry_after_ms = structured.retryAfterMs;
  if (structured.details !== undefined) wire.details = structured.details;
  return wire;
}

/** Error envelope carried in `content` with `isError: true` (SPEC §32). */
export function errorEnvelope(error: unknown): { error: WireError } {
  return { error: serializeError(error) };
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value);
}
