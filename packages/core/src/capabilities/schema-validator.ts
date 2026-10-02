import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import type { ModelDefinition } from '../contracts.js';
import { GatewayError } from '../errors.js';

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false, allowUnionTypes: true });
const cache = new Map<string, ValidateFunction>();

function compiled(model: ModelDefinition): ValidateFunction | undefined {
  const schema = model.inputSchema;
  if (schema === undefined) return undefined;
  const existing = cache.get(model.id);
  if (existing !== undefined) return existing;
  const validate = ajv.compile(schema);
  cache.set(model.id, validate);
  return validate;
}

/** Validates provider input against the model's published input schema. */
export function validateProviderInput(model: ModelDefinition, input: Record<string, unknown>): void {
  const validate = compiled(model);
  if (validate === undefined) return;
  if (validate(input)) return;
  const first = validate.errors?.[0];
  const path = first?.instancePath === undefined || first.instancePath === '' ? '(root)' : first.instancePath;
  throw new GatewayError('INVALID_INPUT', `Input rejected by the ${model.id} schema at ${path}.`, {
    details: {
      model: model.id,
      keyword: first?.keyword,
      path,
      allowed: first?.params === undefined ? undefined : Object.keys(first.params).slice(0, 8)
    }
  });
}

const PRIVATE_HOST_PATTERN =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|\[?::1\]?$|\[?fc|\[?fd|\[?fe80)/i;

/**
 * Provider-side media fields accept only public https URLs: the provider fetches
 * them, so a literal internal address would be an SSRF primitive we cannot audit.
 */
export function assertSafeProviderUrls(input: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && /url$/i.test(key)) {
      assertPublicHttpsUrl(value, key);
      continue;
    }
    if (Array.isArray(value) && /urls$/i.test(key)) {
      for (const item of value) {
        if (typeof item === 'string') assertPublicHttpsUrl(item, key);
      }
    }
  }
}

export function assertPublicHttpsUrl(url: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GatewayError('INVALID_INPUT', `${field} must be an absolute HTTPS URL.`, { details: { field } });
  }
  if (parsed.protocol !== 'https:') {
    throw new GatewayError('INVALID_INPUT', `${field} must use HTTPS.`, { details: { field } });
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new GatewayError('INVALID_INPUT', `${field} must not contain credentials.`, { details: { field } });
  }
  const host = parsed.hostname.replaceAll('[', '').replaceAll(']', '');
  if (PRIVATE_HOST_PATTERN.test(host) || PRIVATE_HOST_PATTERN.test(parsed.hostname)) {
    throw new GatewayError('INVALID_INPUT', `${field} must not point at a private or loopback address.`, {
      details: { field }
    });
  }
}
