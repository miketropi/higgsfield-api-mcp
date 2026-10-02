/**
 * Primitive parsers shared by the environment reader, the CLI reader, and the
 * JSON file loaders. Every parser is total: it either returns a value or a
 * single human-readable failure message. Callers accumulate messages so a
 * broken configuration reports every problem at once.
 */

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function parseFail(message: string): ParseResult<never> {
  return { ok: false, message };
}

export interface IntBounds {
  readonly min?: number | undefined;
  readonly max?: number | undefined;
}

const INTEGER_PATTERN = /^[+-]?\d+$/;
const DECIMAL_PATTERN = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

/** Strict base-10 integer; rejects `1.5`, `1e3`, `0x10`, `NaN`, `Infinity`. */
export function parseIntValue(raw: string, bounds: IntBounds = {}): ParseResult<number> {
  if (!INTEGER_PATTERN.test(raw)) return parseFail(`expected an integer, received "${raw}"`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return parseFail(`integer "${raw}" is out of the supported range`);
  return checkBounds(value, raw, bounds);
}

/** Strict decimal number; rejects `NaN`, `Infinity`, hex, and empty input. */
export function parseNumberValue(raw: string, bounds: IntBounds = {}): ParseResult<number> {
  if (!DECIMAL_PATTERN.test(raw)) return parseFail(`expected a number, received "${raw}"`);
  const value = Number(raw);
  if (!Number.isFinite(value)) return parseFail(`number "${raw}" is not finite`);
  return checkBounds(value, raw, bounds);
}

function checkBounds(value: number, raw: string, bounds: IntBounds): ParseResult<number> {
  if (bounds.min !== undefined && value < bounds.min) {
    return parseFail(`must be >= ${bounds.min}, received ${raw}`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    return parseFail(`must be <= ${bounds.max}, received ${raw}`);
  }
  return parseOk(value);
}

const TRUE_VALUES: Record<string, true> = { true: true, '1': true, yes: true, on: true };
const FALSE_VALUES: Record<string, true> = { false: true, '0': true, no: true, off: true };

export function parseBooleanValue(raw: string): ParseResult<boolean> {
  const value = raw.toLowerCase();
  if (TRUE_VALUES[value] === true) return parseOk(true);
  if (FALSE_VALUES[value] === true) return parseOk(false);
  return parseFail(`expected a boolean (true/false), received "${raw}"`);
}

export function parseEnumValue<const T extends string>(raw: string, allowed: readonly T[]): ParseResult<T> {
  const value = allowed.find((candidate) => candidate === raw);
  if (value === undefined) return parseFail(`expected one of ${allowed.join(' | ')}, received "${raw}"`);
  return parseOk(value);
}

/**
 * Comma-separated list: entries are trimmed, empty entries dropped, and
 * duplicates rejected (a duplicate is always an operator mistake, and for
 * allowlists it silently changes nothing).
 */
export function parseListValue(raw: string): ParseResult<string[]> {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (item === '') continue;
    if (seen.has(item)) return parseFail(`duplicate entry "${item}"`);
    seen.add(item);
    items.push(item);
  }
  return parseOk(items);
}

export function parseNonEmptyValue(raw: string, maxLength = 4096): ParseResult<string> {
  if (raw.length === 0) return parseFail('must not be empty');
  if (raw.length > maxLength) return parseFail(`must be at most ${maxLength} characters`);
  return parseOk(raw);
}

export interface UrlConstraints {
  /** Require the `https:` scheme. */
  readonly httpsOnly?: boolean | undefined;
}

/** Absolute http(s) URL; userinfo (embedded credentials) is rejected. */
export function parseHttpUrl(raw: string, constraints: UrlConstraints = {}): ParseResult<string> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return parseFail(`expected an absolute URL, received "${raw}"`);
  }
  const allowed = constraints.httpsOnly === true ? ['https:'] : ['http:', 'https:'];
  if (!allowed.includes(parsed.protocol)) {
    return parseFail(`expected an ${allowed.join(' or ')} URL, received "${raw}"`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return parseFail('URLs must not embed credentials; use an environment variable instead');
  }
  return parseOk(raw);
}

/** Absolute filesystem path (POSIX or Windows drive) without `..` segments. */
export function parseAbsolutePath(raw: string): ParseResult<string> {
  if (raw.includes('\0')) return parseFail('must not contain NUL bytes');
  const isAbsolute = raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw);
  if (!isAbsolute) return parseFail(`must be an absolute path, received "${raw}"`);
  if (raw.split(/[\\/]/).includes('..')) return parseFail(`must not contain ".." segments, received "${raw}"`);
  return parseOk(raw);
}

/**
 * Base64 decoding to exactly 32 bytes. Accepts standard and URL-safe alphabets
 * with or without padding, but rejects anything that does not round-trip so a
 * truncated or garbage key fails at startup rather than at first use.
 */
export function isValidEncryptionKey(raw: string): boolean {
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (normalized.length === 0 || !/^[A-Za-z0-9+/]+$/.test(normalized)) return false;
  const bytes = Buffer.from(normalized, 'base64');
  return bytes.length === 32 && bytes.toString('base64').replace(/=+$/, '') === normalized;
}
