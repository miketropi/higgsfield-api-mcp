import type { MediaAsset, MediaType, ProviderAssetRef } from '../contracts.js';
import { newId } from '../ids.js';

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  zip: 'application/zip',
  ply: 'application/octet-stream',
  fbx: 'application/octet-stream',
  glb: 'model/gltf-binary'
};

export function inferMimeType(url: string, fallback: MediaType): string {
  const path = url.split('?')[0] ?? url;
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  const known = MIME_BY_EXTENSION[extension];
  if (known !== undefined) return known;
  if (fallback === 'image') return 'image/png';
  if (fallback === 'video') return 'video/mp4';
  if (fallback === 'audio') return 'audio/mpeg';
  return 'application/octet-stream';
}

/**
 * Passthrough materialization of a provider result reference. Managed mode copies
 * these into object storage before exposure (media service responsibility).
 */
export function createAssetFromProviderRef(
  ref: ProviderAssetRef,
  params: { tenantId: string; provider: string; jobId: string; workspaceId?: string | undefined; createdAt: string }
): MediaAsset {
  const asset: MediaAsset = {
    id: newId('asset'),
    tenantId: params.tenantId,
    provider: params.provider,
    mediaType: ref.mediaType,
    mimeType: ref.mimeType ?? inferMimeType(ref.url, ref.mediaType),
    url: ref.url,
    createdAt: params.createdAt,
    origin: 'provider',
    storageKey: params.jobId
  };
  if (ref.size !== undefined) asset.size = ref.size;
  if (ref.width !== undefined) asset.width = ref.width;
  if (ref.height !== undefined) asset.height = ref.height;
  if (ref.durationSeconds !== undefined) asset.durationSeconds = ref.durationSeconds;
  if (params.workspaceId !== undefined) asset.workspaceId = params.workspaceId;
  return asset;
}
