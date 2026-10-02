/**
 * Identifier and URL safety for the Higgsfield adapter.
 *
 * Everything the adapter puts on the wire is constructed from a documented
 * endpoint id, a provider-issued opaque id, or a provider-issued URL. These
 * helpers are the single choke point that turns such a value into a path
 * component or rejects it, so no caller-controlled string can introduce a path
 * separator, traversal, query string or absolute URL.
 */
import { isIPv4, isIPv6 } from 'node:net';
import { GatewayError } from '@higgsfield-mcp/core';

/**
 * One safe path component: unreserved URL characters only (RFC 3986
 * `A-Za-z0-9-._~`). This admits the documented UUID request ids, custom
 * reference ids and endpoint id segments, and nothing else.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]{1,200}$/;

/** Documented endpoint ids are lowercase, slash-separated, e.g. `kling-video/v2.5-turbo/pro/text-to-video`. */
const ENDPOINT_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,79}$/;

const PERCENT_ENCODED_ESCAPE = /%2e|%2f|%5c/i;

/**
 * True when `value` is a single safe path component (rejects `.`, `..`, and any
 * separator). Type guard: consumers use it to accept a provider-issued id
 * without a cast.
 */
export function isSafePathSegment(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SEGMENT.test(value) && value !== '.' && value !== '..';
}

/**
 * Returns `value` when it is a single safe path component, otherwise throws
 * `INVALID_INPUT`.
 */
export function assertSafePathSegment(value: unknown, label: string): string {
  if (!isSafePathSegment(value)) {
    throw new GatewayError('INVALID_INPUT', `Unsafe ${label}.`);
  }
  return value;
}

/** Percent-encodes one already-validated path component. */
export function encodePathSegment(value: unknown, label: string): string {
  return encodeURIComponent(assertSafePathSegment(value, label));
}

/**
 * True when `id` is a documented endpoint id: one or more lowercase
 * slash-separated segments, no empty segment, no traversal, no query.
 */
export function isEndpointId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 400) return false;
  if (id.startsWith('/') || id.endsWith('/') || id.includes('//')) return false;
  if (id.includes(':') || id.includes('?') || id.includes('#') || id.includes('\\')) return false;
  if (PERCENT_ENCODED_ESCAPE.test(id)) return false;
  return id.split('/').every((segment) => ENDPOINT_SEGMENT.test(segment));
}

/** Returns the endpoint id percent-encoded per segment, or throws `INVALID_INPUT`. */
export function encodeEndpointId(id: unknown): string {
  if (!isEndpointId(id)) {
    throw new GatewayError('INVALID_INPUT', 'Unsafe or malformed provider endpoint id.');
  }
  return id.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * Documented request paths.
 *
 * Model endpoint paths are structurally similar to arbitrary lowercase paths, so
 * they are matched syntactically here and additionally checked against the
 * bundled catalog by the client.
 *
 * `/{endpoint_id}`: lowercase slash-separated segments, the documented model path shape.
 */
const MODEL_ENDPOINT_PATH = /^\/[a-z0-9][a-z0-9._-]{0,79}(?:\/[a-z0-9][a-z0-9._-]{0,79}){1,7}$/;

/** Fixed-shape documented paths, excluding model endpoints. */
const FIXED_PATHS: readonly RegExp[] = [
  /^\/requests\/[A-Za-z0-9._~-]{1,200}\/(?:status|cancel)$/,
  /^\/files\/generate-upload-url$/,
  /^\/v1\/custom-references$/,
  /^\/v1\/custom-references\/[A-Za-z0-9._~-]{1,200}$/,
  /^\/estimate\/[a-z0-9][a-z0-9._-]{0,79}(?:\/[a-z0-9][a-z0-9._-]{0,79}){0,7}$/
];

const ALLOWED_PATHS: readonly RegExp[] = [...FIXED_PATHS, MODEL_ENDPOINT_PATH];

/** Syntactic shape of a model endpoint path (`/{endpoint_id}`, lowercase segments). */
export function isModelEndpointPath(path: unknown): boolean {
  return typeof path === 'string' && MODEL_ENDPOINT_PATH.test(path);
}

/**
 * True when `path` has one of the fixed documented shapes (`/requests/...`,
 * `/files/...`, `/v1/custom-references...`, `/estimate/...`).
 */
export function isFixedProviderPath(path: unknown): boolean {
  return typeof path === 'string' && FIXED_PATHS.some((pattern) => pattern.test(path));
}

/** True when `path` is a documented provider path and carries no traversal or query. */
export function isAllowedProviderPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 500) return false;
  if (path.includes('?') || path.includes('#') || path.includes('\\') || path.includes('//')) return false;
  if (path.includes('..') || PERCENT_ENCODED_ESCAPE.test(path)) return false;
  if (/[\s\u0000-\u001f]/.test(path)) return false;
  return ALLOWED_PATHS.some((pattern) => pattern.test(path));
}

/** Throws `INVALID_INPUT` unless `path` is a documented provider path. */
export function assertAllowedProviderPath(path: unknown): string {
  if (!isAllowedProviderPath(path)) {
    throw new GatewayError('INVALID_INPUT', 'Refusing to call an undocumented provider path.');
  }
  return path;
}

/**
 * Asserts an absolute, credential-free `http(s)` URL. Used for provider-issued
 * URLs (signed upload targets, asset URLs) that the adapter must not rewrite.
 */
export function assertAbsoluteHttpUrl(url: unknown, label: string): string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
    throw new GatewayError('PROVIDER_ERROR', `Provider returned an unusable ${label}.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GatewayError('PROVIDER_ERROR', `Provider returned an unusable ${label}.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GatewayError('PROVIDER_ERROR', `Provider returned a ${label} with an unsupported scheme.`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new GatewayError('PROVIDER_ERROR', `Provider returned a ${label} containing credentials.`);
  }
  return url;
}

/**
 * True when `url` is an absolute credential-free `http(s)` URL.
 */
export function isUsableHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.username.length === 0 && parsed.password.length === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Address classification for provider-issued URLs
//
// Provider-issued URLs (the signed upload target) are as untrusted as
// caller-supplied media URLs, so they get the same literal-address
// classification as `@higgsfield-mcp/core`'s remote fetcher (SPEC §17). The
// rules are mirrored here because the media layer does not export them from the
// package root; see the report for the proposal to share one implementation.
// ---------------------------------------------------------------------------

/** True for the IPv4 ranges a gateway must never reach (loopback, RFC1918, metadata, …). */
function ipv4IsBlocked(address: string): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  const [a, b, c] = octets;
  if (a === undefined || b === undefined || c === undefined || octets.length !== 4) return true;
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** `::ffff:1.2.3.4`, `::ffff:0102:0304`, `64:ff9b::1.2.3.4`, and `::1.2.3.4`. */
function embeddedIpv4(lower: string): string | undefined {
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted !== null && dotted[1] !== undefined) {
    if (lower.startsWith('::') || lower.startsWith('64:ff9b::') || lower.startsWith('::ffff:')) return dotted[1];
  }
  const hextets = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hextets !== null && hextets[1] !== undefined && hextets[2] !== undefined) {
    const high = Number.parseInt(hextets[1], 16);
    const low = Number.parseInt(hextets[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return undefined;
}

function firstHextet(address: string): number {
  const head = address.split(':')[0];
  return head === undefined || head === '' ? 0 : Number.parseInt(head, 16);
}

/**
 * True when `address` must not be reached: loopback, RFC1918, link-local
 * (including `169.254.169.254` metadata), CGNAT, unspecified, documentation,
 * multicast and reserved ranges, for IPv4 and IPv6 including IPv4-mapped and
 * NAT64 forms. Anything that is neither an IPv4 nor an IPv6 literal is also
 * rejected, so this is only meaningful for literal addresses.
 */
export function isBlockedHostAddress(address: string): boolean {
  if (isIPv4(address)) return ipv4IsBlocked(address);
  if (!isIPv6(address)) return true;

  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const head = firstHextet(lower);
  if ((head & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((head & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((head & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (head === 0x2001 && lower.startsWith('2001:db8')) return true; // documentation

  const mapped = embeddedIpv4(lower);
  if (mapped !== undefined) return ipv4IsBlocked(mapped);
  return false;
}

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/**
 * True when a `URL.hostname` names an internal or local host: a blocked literal
 * address, `localhost`, or a reserved local/internal suffix. `URL.hostname`
 * keeps the brackets around IPv6 literals, so they are stripped first.
 */
export function isBlockedHostname(hostname: string): boolean {
  const stripped = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = stripped.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower === '') return true;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  if (isIPv4(lower) || isIPv6(lower)) return isBlockedHostAddress(lower);
  return false;
}
