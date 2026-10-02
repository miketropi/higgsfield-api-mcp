/**
 * Secret and sensitive-value redaction, shared by logging, error details, audit
 * records, and MCP responses.
 */

const REDACT_KEY_PATTERN = /(authorization|auth|credential|secret|token|password|passwd|signature|apikey|api_key|key_id|access_key|x-amz)/i;
const SENSITIVE_QUERY_PATTERN = /(^|[?&])(x-amz-[a-z-]+|x-goog-[a-z-]+|signature|sig|token|key|access_token|expires|credential|policy|se)($|=)/i;
const MAX_STRING_LENGTH = 2048;
const MAX_ARRAY_ITEMS = 64;
const MAX_DEPTH = 6;

export const REDACTION_CENSOR = '[redacted]';

/** True when a key name must never have its value emitted. */
export function isSensitiveKey(key: string): boolean {
  return REDACT_KEY_PATTERN.test(key);
}

/** Strips the query string entirely: signed-URL queries are credentials. */
export function redactUrlQuery(url: string): string {
  const index = url.indexOf('?');
  if (index === -1) return url;
  return `${url.slice(0, index)}?${REDACTION_CENSOR}`;
}

/** True when a URL carries a signed-credential query string. */
export function hasSensitiveQuery(url: string): boolean {
  return SENSITIVE_QUERY_PATTERN.test(url);
}

export function safeUrlForLogging(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.search.length > 0) parsed.search = '?[redacted]';
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return redactUrlQuery(url);
  }
}

/**
 * Returns a JSON-safe, depth- and size-bounded copy of `value` with sensitive
 * keys removed. Returns `undefined` when nothing survives.
 */
export function sanitizeDetails(value: unknown): Record<string, unknown> | undefined {
  const visit = (input: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (input === null || input === undefined) return undefined;
    const type = typeof input;
    if (type === 'string') {
      const raw = input as string;
      // Signed URLs are credentials: scrub the query string before anything is emitted.
      const text = /^https?:\/\//i.test(raw) && hasSensitiveQuery(raw) ? redactUrlQuery(raw) : raw;
      return text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}…` : text;
    }
    if (type === 'number') return Number.isFinite(input as number) ? input : undefined;
    if (type === 'boolean') return input;
    if (type === 'bigint') return (input as bigint).toString();
    if (type === 'function' || type === 'symbol') return undefined;
    if (input instanceof Error) return { name: input.name };
    if (depth >= MAX_DEPTH) return undefined;
    if (Array.isArray(input)) {
      const items: unknown[] = [];
      for (const item of input.slice(0, MAX_ARRAY_ITEMS)) {
        const next = visit(item, depth + 1, seen);
        if (next !== undefined) items.push(next);
      }
      return items;
    }
    if (type === 'object') {
      const object = input as Record<string, unknown>;
      if (seen.has(object)) return undefined;
      seen.add(object);
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(object)) {
        if (isSensitiveKey(key)) {
          output[key] = REDACTION_CENSOR;
          continue;
        }
        const next = visit(object[key], depth + 1, seen);
        if (next !== undefined) output[key] = next;
      }
      seen.delete(object);
      return output;
    }
    return undefined;
  };
  const result = visit(value, 0, new WeakSet<object>());
  if (result === undefined || result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  return result as Record<string, unknown>;
}
