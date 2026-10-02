import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { GatewayError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 'v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/**
 * Parses a base64-encoded 32-byte key. Absent or malformed keys are fatal in
 * remote mode; callers decide when a key is required.
 */
export function parseEncryptionKey(base64Key: string): Uint8Array {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new GatewayError('INTERNAL_ERROR', 'Data encryption key must decode to exactly 32 bytes.', {
      details: { decodedBytes: key.length }
    });
  }
  return key;
}

/**
 * AES-256-GCM with a fresh 96-bit nonce per value. `context` is authenticated so
 * a ciphertext cannot be replayed against another tenant or job.
 */
export function encryptJson(key: Uint8Array, context: string, value: unknown): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    nonce.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url')
  ].join('.');
}

export function isEncryptionEnvelope(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts[0] === ENVELOPE_VERSION;
}

export function decryptJson<T>(key: Uint8Array, context: string, envelope: string): T {
  const parts = envelope.split('.');
  const [version, noncePart, ciphertextPart, tagPart] = parts;
  if (parts.length !== 4 || version !== ENVELOPE_VERSION || !noncePart || !ciphertextPart || !tagPart) {
    throw new GatewayError('INTERNAL_ERROR', 'Stored payload is not a recognized encrypted envelope.');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(noncePart, 'base64url'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch (error) {
    throw new GatewayError('INTERNAL_ERROR', 'Stored payload failed authentication.', { cause: error });
  }
}
