import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Id prefixes are stable public contract: they appear in MCP responses. */
export const ID_PREFIXES = {
  job: 'job',
  asset: 'asset',
  request: 'req',
  event: 'evt',
  reservation: 'rsv',
  confirmation: 'cnf'
} as const;
export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

/** Provider-facing idempotency key: random UUID, immutable once persisted. */
export function newUpstreamIdempotencyKey(): string {
  return randomUUID();
}

/** Opaque high-entropy token (webhook callback token, confirmation token). */
export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Base64(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('base64');
}

/** Constant-time comparison of two hex digests of equal length. */
export function digestEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Deterministic JSON with sorted object keys and dropped `undefined` values.
 * Used for request hashing and provider bodies that must replay byte-identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value === undefined ? null : value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item === undefined ? null : item));
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) continue;
    output[key] = canonicalize(item);
  }
  return output;
}
