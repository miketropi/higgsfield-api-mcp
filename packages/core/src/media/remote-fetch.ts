import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIPv4, isIPv6 } from 'node:net';
import type { LoggerPort, MediaType } from '../contracts.js';
import { GatewayError } from '../errors.js';
import { safeUrlForLogging } from '../redact.js';
import { isAllowedUploadMimeType, mediaTypeForMime, sniffMimeType } from './mime.js';

export interface RemoteMedia {
  bytes: Uint8Array;
  mimeType: string;
  mediaType: MediaType;
  declaredMimeType?: string | undefined;
}

export interface RemoteFetcherOptions {
  maxBytes: number;
  downloadTimeoutMs: number;
  maxRedirects: number;
  logger: LoggerPort;
  /**
   * `upload` (default) restricts content to the provider's accepted upload
   * types; `result` accepts any recognizable image/video/audio, which is what a
   * provider result may legitimately contain (e.g. `video/webm`).
   */
  mimePolicy?: 'upload' | 'result' | undefined;
  /** Test seam; production uses the pinned `node:https` transport below. */
  fetchImpl?: typeof fetch | undefined;
  /** Test seam; defaults to `node:dns` `lookup` with `all: true`. */
  resolveHost?: ((hostname: string) => Promise<string[]>) | undefined;
}

export interface RemoteFetcher {
  /** Validates and downloads, following at most `maxRedirects` hops. */
  fetchMedia(rawUrl: string, signal?: AbortSignal | undefined): Promise<RemoteMedia>;
}

const ALLOWED_SCHEME = 'https:';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REDIRECT_BODY_CAP = 8192;
const ACCEPT_HEADER = 'image/*, video/mp4, audio/*';

function ipv4Blocked(address: string): boolean {
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
function embeddedIPv4(lower: string): string | undefined {
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
  const [head] = address.split(':');
  return head === undefined || head === '' ? 0 : Number.parseInt(head, 16);
}

/**
 * Rejects every address a caller-controlled download must never reach:
 * loopback, RFC1918, link-local (including cloud metadata endpoints), CGNAT,
 * unspecified, documentation, multicast, and reserved ranges — for IPv4 and
 * IPv6, including IPv4-mapped and NAT64 forms.
 */
export function isBlockedAddress(address: string): boolean {
  if (isIPv4(address)) return ipv4Blocked(address);
  if (!isIPv6(address)) return true;

  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const head = firstHextet(lower);
  if ((head & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((head & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((head & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (head === 0x2001 && lower.startsWith('2001:db8')) return true; // documentation

  const mapped = embeddedIPv4(lower);
  if (mapped !== undefined) return ipv4Blocked(mapped);
  return false;
}

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** `URL.hostname` keeps the brackets around IPv6 literals. */
function unbracketedHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export function isBlockedHostname(hostname: string): boolean {
  const lower = unbracketedHost(hostname).toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower === '') return true;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  if (isIPv4(lower) || isIPv6(lower)) return isBlockedAddress(lower);
  return false;
}

/**
 * Syntax-only URL validation (scheme, userinfo, hostname shape). DNS-dependent
 * checks live in `resolveAllowedAddress` so `identify` can validate a URL
 * without touching the network.
 */
export function assertRemoteUrlSyntax(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GatewayError('INVALID_INPUT', 'Media URLs must be absolute https URLs.');
  }
  if (parsed.protocol !== ALLOWED_SCHEME) {
    throw new GatewayError('INVALID_INPUT', 'Media URLs must use https.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new GatewayError('INVALID_INPUT', 'Media URLs must not embed credentials.');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new GatewayError('INVALID_INPUT', 'Media URLs must not target local or internal hosts.');
  }
  return parsed;
}

interface HttpProbe {
  status: number;
  location: string | undefined;
  contentType: string | undefined;
  contentLength: number | undefined;
  bytes: Uint8Array;
  truncated: boolean;
}

async function readCapped(stream: AsyncIterable<Uint8Array>, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    const remaining = cap + 1 - total;
    if (buffer.byteLength >= remaining) {
      chunks.push(buffer.subarray(0, remaining));
      truncated = true;
      break;
    }
    chunks.push(buffer);
    total += buffer.byteLength;
  }
  // `Buffer.concat` yields a `Buffer`; the public contract is a plain
  // `Uint8Array`, and this view is zero-copy.
  const joined = Buffer.concat(chunks);
  return { bytes: new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength), truncated };
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeContentType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const [base] = value.split(';');
  return base?.trim().toLowerCase();
}

/**
 * Pinned HTTPS GET. DNS is performed once by the caller (through the injected
 * resolver), every returned address is validated, and the validated address is
 * then handed to Node through the `lookup` option of `https.request`. Node
 * therefore performs no second, independent resolution — there is no rebinding
 * window — while `servername` (TLS SNI, certificate verification) and the `Host`
 * header still carry the original hostname.
 */
function pinnedProbe(url: URL, address: string, signal: AbortSignal, cap: number): Promise<HttpProbe> {
  return new Promise<HttpProbe>((resolveProbe, rejectProbe) => {
    const request = httpsRequest(
      {
        hostname: unbracketedHost(url.hostname),
        servername: unbracketedHost(url.hostname),
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: url.host, accept: ACCEPT_HEADER, 'user-agent': 'higgsfield-mcp-gateway' },
        lookup: (_hostname, _options, callback) => {
          callback(null, address, isIPv6(address) ? 6 : 4);
        },
        signal
      },
      (response) => {
        void (async () => {
          const { bytes, truncated } = await readCapped(response, cap);
          if (truncated) request.destroy();
          resolveProbe({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            contentType: response.headers['content-type'],
            contentLength: numberOrUndefined(response.headers['content-length']),
            bytes,
            truncated
          });
        })().catch(rejectProbe);
      }
    );
    request.on('error', rejectProbe);
    request.end();
  });
}

function translateTransportError(error: unknown, url: string, logger: LoggerPort): GatewayError {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : name;
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR') {
    return new GatewayError('TIMEOUT', `Media download timed out for ${safeUrlForLogging(url)}.`);
  }
  logger.warn({ url: safeUrlForLogging(url), code }, 'Media download failed.');
  return new GatewayError('MEDIA_UPLOAD_FAILED', `Media download failed for ${safeUrlForLogging(url)}.`);
}

export function createRemoteFetcher(options: RemoteFetcherOptions): RemoteFetcher {
  const resolveHost =
    options.resolveHost ??
    (async (hostname: string): Promise<string[]> => {
      const records = await dnsLookup(hostname, { all: true, verbatim: true });
      return records.map((record) => record.address);
    });

  const resolveAllowedAddress = async (url: URL): Promise<string> => {
    const host = unbracketedHost(url.hostname);
    let addresses: string[];
    try {
      addresses = await resolveHost(host);
    } catch {
      throw new GatewayError('MEDIA_UPLOAD_FAILED', `Media host ${host} could not be resolved.`);
    }
    if (addresses.length === 0) {
      throw new GatewayError('MEDIA_UPLOAD_FAILED', `Media host ${host} could not be resolved.`);
    }
    const blocked = addresses.filter((address) => isBlockedAddress(address));
    if (blocked.length > 0) {
      throw new GatewayError('INVALID_INPUT', `Media host ${host} resolves to a blocked address.`);
    }
    const [first] = addresses;
    if (first === undefined) {
      throw new GatewayError('MEDIA_UPLOAD_FAILED', `Media host ${host} could not be resolved.`);
    }
    return first;
  };

  const probe = async (url: URL, address: string, signal: AbortSignal, cap: number): Promise<HttpProbe> => {
    if (options.fetchImpl === undefined) return pinnedProbe(url, address, signal, cap);
    const response = await options.fetchImpl(url, { method: 'GET', redirect: 'manual', signal, headers: { accept: ACCEPT_HEADER } });
    const body = response.body;
    const { bytes, truncated } = body === null ? { bytes: new Uint8Array(), truncated: false } : await readCapped(body, cap);
    return {
      status: response.status,
      location: response.headers.get('location') ?? undefined,
      contentType: response.headers.get('content-type') ?? undefined,
      contentLength: numberOrUndefined(response.headers.get('content-length') ?? undefined),
      bytes,
      truncated
    };
  };

  const fetchMedia = async (rawUrl: string, signal?: AbortSignal | undefined): Promise<RemoteMedia> => {
    let current = assertRemoteUrlSyntax(rawUrl).toString();
    const visited = new Set<string>();

    for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
      const parsed = assertRemoteUrlSyntax(current);
      if (visited.has(parsed.toString())) {
        throw new GatewayError('MEDIA_UPLOAD_FAILED', 'Media download redirect loop detected.');
      }
      visited.add(parsed.toString());
      const address = await resolveAllowedAddress(parsed);

      const timeoutSignal = AbortSignal.timeout(options.downloadTimeoutMs);
      const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const isRedirectHop = hop < options.maxRedirects;
      let response: HttpProbe;
      try {
        response = await probe(parsed, address, combined, isRedirectHop ? REDIRECT_BODY_CAP : options.maxBytes);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw translateTransportError(error, parsed.toString(), options.logger);
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        if (response.location === undefined) {
          throw new GatewayError('MEDIA_UPLOAD_FAILED', 'Media download redirect had no target.');
        }
        let next: string;
        try {
          next = new URL(response.location, parsed).toString();
        } catch {
          throw new GatewayError('MEDIA_UPLOAD_FAILED', 'Media download redirect target was not a valid URL.');
        }
        // Every check runs again on the next hop, including scheme, host shape,
        // DNS resolution, and address classification.
        current = next;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new GatewayError('MEDIA_UPLOAD_FAILED', `Media download failed with HTTP ${response.status}.`);
      }
      if (response.contentLength !== undefined && response.contentLength > options.maxBytes) {
        throw new GatewayError('INVALID_INPUT', `Media exceeds the ${options.maxBytes} byte upload limit.`);
      }
      if (response.truncated || response.bytes.byteLength > options.maxBytes) {
        throw new GatewayError('INVALID_INPUT', `Media exceeds the ${options.maxBytes} byte upload limit.`);
      }
      if (response.contentLength !== undefined && response.contentLength !== response.bytes.byteLength) {
        throw new GatewayError('MEDIA_UPLOAD_FAILED', 'Media download length did not match the declared content length.');
      }
      if (response.bytes.byteLength === 0) {
        throw new GatewayError('INVALID_INPUT', 'The downloaded media was empty.');
      }

      const declaredMimeType = normalizeContentType(response.contentType);
      const mimeType = sniffMimeType(response.bytes);
      const mediaType = mimeType === undefined ? undefined : mediaTypeForMime(mimeType);
      if (mimeType === undefined || mediaType === undefined) {
        throw new GatewayError('INVALID_INPUT', 'Unsupported media type: the downloaded content is not a supported media type.');
      }
      if (options.mimePolicy !== 'result' && !isAllowedUploadMimeType(mimeType)) {
        throw new GatewayError('INVALID_INPUT', `Unsupported media type ${mimeType}: the provider does not accept it as an upload.`);
      }
      return { bytes: response.bytes, mimeType, mediaType, declaredMimeType };
    }

    throw new GatewayError('MEDIA_UPLOAD_FAILED', `Media download exceeded ${options.maxRedirects} redirects.`);
  };

  return { fetchMedia };
}
