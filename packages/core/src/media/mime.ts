import type { MediaType } from '../contracts.js';

/**
 * Provider-documented upload media types (SPEC §15). Anything else is rejected
 * before the bytes reach the provider.
 */
export const ALLOWED_UPLOAD_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'audio/wav',
  'audio/x-wav',
  'video/mp4'
];

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4'
};

const ASCII = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, ...ASCII('PNG'), 0x0d, 0x0a, 0x1a, 0x0a];
const GIF87_MAGIC = ASCII('GIF87a');
const GIF89_MAGIC = ASCII('GIF89a');
const RIFF_MAGIC = ASCII('RIFF');
const WEBP_MAGIC = ASCII('WEBP');
const WAVE_MAGIC = ASCII('WAVE');
const FTYP_MAGIC = ASCII('ftyp');
/** EBML header: Matroska/WebM. */
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
const ID3_MAGIC = ASCII('ID3');

function matchesAt(bytes: Uint8Array, magic: readonly number[], offset: number): boolean {
  if (bytes.byteLength < offset + magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[offset + index] !== magic[index]) return false;
  }
  return true;
}

/**
 * Content sniffing by magic bytes. The declared extension, `content-type`
 * header, and caller hints are never trusted: only the bytes decide the type.
 */
export function sniffMimeType(bytes: Uint8Array): string | undefined {
  if (matchesAt(bytes, JPEG_MAGIC, 0)) return 'image/jpeg';
  if (matchesAt(bytes, PNG_MAGIC, 0)) return 'image/png';
  if (matchesAt(bytes, GIF87_MAGIC, 0) || matchesAt(bytes, GIF89_MAGIC, 0)) return 'image/gif';
  if (matchesAt(bytes, RIFF_MAGIC, 0) && matchesAt(bytes, WEBP_MAGIC, 8)) return 'image/webp';
  if (matchesAt(bytes, RIFF_MAGIC, 0) && matchesAt(bytes, WAVE_MAGIC, 8)) return 'audio/wav';
  if (matchesAt(bytes, FTYP_MAGIC, 4)) return 'video/mp4';
  if (matchesAt(bytes, EBML_MAGIC, 0)) return 'video/webm';
  if (matchesAt(bytes, ID3_MAGIC, 0)) return 'audio/mpeg';

  const [first, second] = bytes;
  if (first === 0xff && second !== undefined && (second & 0xe0) === 0xe0) return 'audio/mpeg';
  return undefined;
}

export function mediaTypeForMime(mimeType: string): MediaType | undefined {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return undefined;
}

export function isAllowedUploadMimeType(mimeType: string): boolean {
  return ALLOWED_UPLOAD_MIME_TYPES.includes(mimeType);
}

/** Extension-only hint, used where the bytes cannot be inspected (see `identify`). */
export function mimeTypeFromExtension(value: string): string | undefined {
  const path = value.split('?')[0] ?? value;
  const separator = path.lastIndexOf('.');
  if (separator === -1) return undefined;
  return MIME_BY_EXTENSION[path.slice(separator + 1).toLowerCase()];
}

/**
 * Best-effort media type for a URL that must not be downloaded: the identity
 * hash only needs a deterministic value, and the authoritative type is
 * established from the bytes during `resolve`. Unknown extensions default to
 * `image`, the most common generation input.
 */
export function mediaTypeFromExtension(value: string): MediaType {
  return mediaTypeForMime(mimeTypeFromExtension(value) ?? '') ?? 'image';
}
