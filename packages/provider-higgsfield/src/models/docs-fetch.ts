/**
 * Fetching for the provider's *public documentation directory*.
 *
 * This is deliberately not the credentialed HTTP client: model discovery reads a
 * public, unauthenticated Markdown site and must never carry provider secrets,
 * never reach the provider API origin, and never follow a link off that site.
 * Every URL — initial and redirected — is re-validated against one policy, every
 * response is size-capped while it streams, and the whole crawl has page and byte
 * budgets so a hostile or broken page cannot turn a discovery call into a resource
 * drain.
 */
import type { HiggsfieldFetch } from '../client/http.js';

/** The only origin documentation is read from. */
export const DOCUMENTATION_ORIGIN = 'https://docs.higgsfield.ai';

/** Fixed entry point: the provider's Model API Reference index. */
export const DOCUMENTATION_INDEX_URL = `${DOCUMENTATION_ORIGIN}/docs/models.md`;

/** Every documentation path must live under this prefix. */
export const DOCUMENTATION_PATH_PREFIX = '/docs/models';

/** Percent-encoded `.`, `/` and `\`: rejected before any URL normalization can hide them. */
const PERCENT_ENCODED_ESCAPE = /%2e|%2f|%5c/i;

export interface DocumentationFetchLimits {
  /** Redirects followed for one page (each hop re-validated). */
  maxRedirects: number;
  /** Bytes accepted from one response. */
  maxResponseBytes: number;
  /** Bytes accepted across the whole crawl. */
  maxTotalBytes: number;
  /** Pages requested across the whole crawl. */
  maxPages: number;
  /** Per-request timeout. */
  requestTimeoutMs: number;
}

export const DEFAULT_DOCUMENTATION_FETCH_LIMITS: DocumentationFetchLimits = Object.freeze({
  maxRedirects: 3,
  maxResponseBytes: 2 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxPages: 512,
  requestTimeoutMs: 10_000
});

export type DocumentationFetchFailure =
  | 'url_not_allowed'
  | 'page_limit_exceeded'
  | 'redirect_without_location'
  | 'too_many_redirects'
  | 'http_status'
  | 'unexpected_content_type'
  | 'response_too_large'
  | 'total_bytes_exceeded'
  | 'transport_error';

/** Safe, body-free failure detail. Never carries a response body or a URL query. */
export class DocumentationFetchError extends Error {
  readonly reason: DocumentationFetchFailure;
  readonly status?: number | undefined;

  constructor(reason: DocumentationFetchFailure, status?: number | undefined) {
    super(`Documentation fetch failed: ${reason}.`);
    this.name = 'DocumentationFetchError';
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

export interface DocumentationFetcherOptions {
  /** Injected transport; defaults to the global `fetch`. */
  fetch?: HiggsfieldFetch | undefined;
  limits?: Partial<DocumentationFetchLimits> | undefined;
}

export interface DocumentationFetcher {
  /** Fetches one canonical documentation page, returning its Markdown body. */
  fetchPage(url: string): Promise<string>;
  /** Pages requested so far (redirect hops excluded). */
  readonly pages: number;
  /** Bytes accepted so far. */
  readonly bytes: number;
}

/**
 * True when `value` is a URL this gateway may request: HTTPS, the documentation
 * origin, the default port, no credentials, no query or fragment, a `/docs/models`
 * path, and no encoded traversal.
 */
export function isAllowedDocumentationUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname !== 'docs.higgsfield.ai') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.port !== '' && parsed.port !== '443') return false;
  if (parsed.search !== '' || parsed.hash !== '') return false;
  if (!parsed.pathname.startsWith(DOCUMENTATION_PATH_PREFIX)) return false;
  if (PERCENT_ENCODED_ESCAPE.test(parsed.pathname)) return false;
  if (/[\s\u0000-\u001f]/.test(parsed.pathname)) return false;
  return true;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

export function createDocumentationFetcher(options: DocumentationFetcherOptions = {}): DocumentationFetcher {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const limits: DocumentationFetchLimits = { ...DEFAULT_DOCUMENTATION_FETCH_LIMITS, ...(options.limits ?? {}) };
  let pages = 0;
  let bytes = 0;

  const request = async (url: string): Promise<Response> => {
    try {
      return await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(limits.requestTimeoutMs),
        headers: {
          accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1',
          // Documentation is public: no Authorization and no provider credential.
          'user-agent': 'higgsfield-mcp-model-discovery'
        }
      });
    } catch {
      throw new DocumentationFetchError('transport_error');
    }
  };

  const readBody = async (response: Response): Promise<string> => {
    const contentType = response.headers.get('content-type');
    if (contentType !== null && contentType.toLowerCase().includes('text/html')) {
      throw new DocumentationFetchError('unexpected_content_type');
    }
    if (response.body === null) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > limits.maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DocumentationFetchError('response_too_large');
      }
      if (bytes + size > limits.maxTotalBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DocumentationFetchError('total_bytes_exceeded');
      }
      chunks.push(value);
    }
    bytes += size;
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(merged);
  };

  return {
    get pages() {
      return pages;
    },
    get bytes() {
      return bytes;
    },

    async fetchPage(url: string): Promise<string> {
      if (!isAllowedDocumentationUrl(url)) {
        throw new DocumentationFetchError('url_not_allowed');
      }
      if (pages >= limits.maxPages) {
        throw new DocumentationFetchError('page_limit_exceeded');
      }
      pages += 1;
      let current = url;
      for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
        const response = await request(current);
        if (isRedirect(response.status)) {
          const location = response.headers.get('location');
          if (location === null) throw new DocumentationFetchError('redirect_without_location');
          let next: string;
          try {
            next = new URL(location, current).href;
          } catch {
            throw new DocumentationFetchError('url_not_allowed');
          }
          if (!isAllowedDocumentationUrl(next)) throw new DocumentationFetchError('url_not_allowed');
          current = next;
          continue;
        }
        if (response.status !== 200) throw new DocumentationFetchError('http_status', response.status);
        return await readBody(response);
      }
      throw new DocumentationFetchError('too_many_redirects');
    }
  };
}

/**
 * Canonical documentation URL for a link found in a crawled page: resolved against
 * the page, stripped of query and fragment, and normalized to the `.md` form the
 * site serves. Returns `undefined` for anything that is not a documentation URL.
 */
export function canonicalDocumentationUrl(target: string, base: string): string | undefined {
  if (typeof target !== 'string' || target.length === 0 || target.length > 2048) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(target, base);
  } catch {
    return undefined;
  }
  parsed.hash = '';
  parsed.search = '';
  if (parsed.pathname.endsWith('/')) parsed.pathname = parsed.pathname.slice(0, -1);
  if (!parsed.pathname.endsWith('.md')) parsed.pathname = `${parsed.pathname}.md`;
  const canonical = parsed.href;
  return isAllowedDocumentationUrl(canonical) ? canonical : undefined;
}
