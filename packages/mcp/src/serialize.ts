import type { MediaAsset, StructuredError } from '@higgsfield-mcp/core';
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

export const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['image', 'video', 'audio', '3d']),
  status: z.enum(['active', 'deprecated', 'experimental']),
  capabilities: z.array(z.string()),
  endpoint: z.string(),
  limits: z.record(z.string(), z.unknown()),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  pricing: z
    .object({
      currency: z.literal('USD'),
      unit_micro_usd: z.number().optional(),
      per_second_micro_usd: z.number().optional(),
      source: z.string(),
      as_of: z.string()
    })
    .optional(),
  source: z.object({ url: z.string(), as_of: z.string() })
});

export const modelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['image', 'video', 'audio', '3d']),
  status: z.enum(['active', 'deprecated', 'experimental']),
  capabilities: z.array(z.string())
});

export const capabilitiesSchema = z.object({
  gateway_version: z.string(),
  mcp_protocol: z.string(),
  provider: z.object({ id: z.string(), version: z.string() }),
  skills_version: z.string(),
  capabilities: z.array(z.string()),
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
export type WireModel = z.infer<typeof modelSchema>;
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
