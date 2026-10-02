import type { AuthContext, MediaReference, RequestContext, Scope } from '@higgsfield-mcp/core';
import { GatewayError, SCOPES } from '@higgsfield-mcp/core';
import { z } from 'zod';

/** Tool inputs are frozen public API (SPEC §57): snake_case, additive changes only. */
export const mediaReferenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), url: z.string().min(1) }).strict(),
  z.object({ type: z.literal('asset'), asset_id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('file'), path: z.string().min(1) }).strict()
]);

const requestFields = {
  wait: z.boolean().optional(),
  idempotency_key: z.string().min(1).max(255).optional(),
  workspace_id: z.string().min(1).optional(),
  confirmation_token: z.string().min(1).optional()
};

export const generateImageInput = z
  .object({
    prompt: z.string().min(1),
    negative_prompt: z.string().optional(),
    aspect_ratio: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    quality: z.enum(['draft', 'standard', 'high']).optional(),
    style: z.string().optional(),
    reference_images: z.array(mediaReferenceSchema).optional(),
    model: z.string().optional(),
    seed: z.number().int().optional(),
    count: z.number().int().positive().optional(),
    ...requestFields
  })
  .strict();

export const editImageInput = z
  .object({
    prompt: z.string().min(1),
    image: mediaReferenceSchema,
    mask: mediaReferenceSchema.optional(),
    references: z.array(mediaReferenceSchema).optional(),
    model: z.string().optional(),
    preserve_identity: z.boolean().optional(),
    aspect_ratio: z.string().optional(),
    seed: z.number().int().optional(),
    ...requestFields
  })
  .strict();

export const generateVideoInput = z
  .object({
    prompt: z.string().min(1),
    start_image: mediaReferenceSchema.optional(),
    end_image: mediaReferenceSchema.optional(),
    references: z.array(mediaReferenceSchema).optional(),
    duration: z.number().int().positive().optional(),
    aspect_ratio: z.string().optional(),
    resolution: z.string().optional(),
    audio: z.boolean().optional(),
    model: z.string().optional(),
    quality: z.string().optional(),
    ...requestFields
  })
  .strict();

export const animateImageInput = z
  .object({
    image: mediaReferenceSchema,
    prompt: z.string().min(1),
    duration: z.number().int().positive().optional(),
    motion_strength: z.string().optional(),
    camera_motion: z.string().optional(),
    model: z.string().optional(),
    ...requestFields
  })
  .strict();

export const generateInput = z
  .object({
    endpoint: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    webhook: z.object({ url: z.string().min(1) }).strict().optional(),
    ...requestFields
  })
  .strict();

export const mediaUploadInput = z
  .object({
    source: z.union([z.object({ path: z.string().min(1) }).strict(), z.object({ url: z.string().min(1) }).strict()]),
    media_type: z.enum(['image', 'video', 'audio']).optional()
  })
  .strict();

export const mediaGetInput = z.object({ asset_id: z.string().min(1) }).strict();
export const modelsListInput = z
  .object({ type: z.enum(['image', 'video', 'audio', '3d']).optional(), capability: z.string().optional() })
  .strict();
export const modelsGetInput = z.object({ model: z.string().min(1) }).strict();
export const jobsGetInput = z.object({ job_id: z.string().min(1) }).strict();
export const jobsWaitInput = z.object({ job_id: z.string().min(1), timeout_ms: z.number().int().nonnegative().optional() }).strict();
export const jobsListInput = z.object({ cursor: z.string().min(1).optional() }).strict();

export type MediaReferenceInput = z.infer<typeof mediaReferenceSchema>;
export type GenerateImageArgs = z.infer<typeof generateImageInput>;
export type EditImageArgs = z.infer<typeof editImageInput>;
export type GenerateVideoArgs = z.infer<typeof generateVideoInput>;
export type AnimateImageArgs = z.infer<typeof animateImageInput>;
export type GenerateArgs = z.infer<typeof generateInput>;
export type MediaUploadArgs = z.infer<typeof mediaUploadInput>;

export function toCoreMediaReference(reference: MediaReferenceInput): MediaReference {
  if (reference.type === 'url') return { type: 'url', url: reference.url };
  if (reference.type === 'asset') return { type: 'asset', assetId: reference.asset_id };
  return { type: 'file', path: reference.path };
}

function looksLikeMediaReference(value: Record<string, unknown>): boolean {
  const type = value['type'];
  if (type === 'url') return typeof value['url'] === 'string';
  if (type === 'asset') return typeof value['asset_id'] === 'string';
  if (type === 'file') return typeof value['path'] === 'string';
  return false;
}

/**
 * Converts `asset_id` wire references to the internal `assetId` form anywhere inside
 * a provider-native input record, leaving every other value untouched.
 */
export function toCoreInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => toCoreInput(item));
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  if (looksLikeMediaReference(record)) {
    const type = record['type'];
    if (type === 'url') return { type: 'url', url: record['url'] as string };
    if (type === 'asset') return { type: 'asset', assetId: record['asset_id'] as string };
    return { type: 'file', path: record['path'] as string };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) out[key] = toCoreInput(item);
  return out;
}

export function requireScope(context: RequestContext, scope: Scope): void {
  const auth: AuthContext | undefined = context.auth;
  if (auth === undefined) return;
  if (!auth.scopes.includes(scope)) {
    throw new GatewayError('ACCESS_DENIED', `This credential is missing the ${scope} scope.`, {
      details: { required_scope: scope }
    });
  }
}

export const TOOL_NAMES = [
  'higgsfield.generate_image',
  'higgsfield.edit_image',
  'higgsfield.generate_video',
  'higgsfield.animate_image',
  'higgsfield.generate',
  'higgsfield.media.upload',
  'higgsfield.media.get',
  'higgsfield.models.list',
  'higgsfield.models.get',
  'higgsfield.capabilities',
  'higgsfield.jobs.get',
  'higgsfield.jobs.wait',
  'higgsfield.jobs.cancel',
  'higgsfield.jobs.list'
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const RESOURCE_URIS = {
  models: 'higgsfield://models',
  modelTemplate: 'higgsfield://models/{id}',
  jobTemplate: 'higgsfield://jobs/{id}',
  assetTemplate: 'higgsfield://assets/{id}',
  capabilities: 'higgsfield://capabilities'
} as const;

export { SCOPES };
