/**
 * Higgsfield HTTP client.
 *
 * One instance per resolved credential binding. The credential is captured at
 * construction and never read from the environment; it appears in exactly one
 * request header and never in a log line, error message or error detail.
 *
 * Guard rails enforced here, uniformly for every call:
 * - `redirect: 'manual'` — a 3xx is a failure, so credentials are never resent
 *   to another origin;
 * - a hard cap on every response body;
 * - an explicit abort-based timeout plus caller-signal propagation;
 * - documented-paths-only construction, with query parameters separate from the
 *   path so nothing caller-supplied can inject a query or traversal.
 */
import { GatewayError, canonicalJson } from '@higgsfield-mcp/core';
import { toAuthorizationValue } from '../credentials.js';
import type { ProviderCredentials } from '@higgsfield-mcp/core';
import {
  ProviderHttpError,
  extractProviderDetail,
  mapProviderHttpError,
  mapProviderTransportError,
  parseRetryAfterMs
} from '../errors.js';
import type { ProviderOperation } from '../errors.js';
import {
  assertAbsoluteHttpUrl,
  assertAllowedProviderPath,
  isBlockedHostname,
  isFixedProviderPath
} from '../paths.js';
import { loadBundledCatalog } from '../models/catalog.js';

/** Documented base URL: https://docs.higgsfield.ai/docs/api-reference/overview.md */
export const HIGGSFIELD_API_BASE_URL = 'https://api.higgsfield.ai';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

/** Largest provider JSON document the adapter will buffer. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Signed-URL PUT responses carry no payload of value. */
const UPLOAD_RESPONSE_MAX_BYTES = 64 * 1024;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

/** Documented: "Keys must contain 1–255 visible ASCII characters without whitespace." */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
const HEADER_VALUE_PATTERN = /^[\x20-\x7e]*$/;
const QUERY_KEY_PATTERN = /^[A-Za-z0-9_.~-]{1,64}$/;

export interface HiggsfieldHttpClientOptions {
  credentials: ProviderCredentials;
  baseUrl?: string | undefined;
  requestTimeoutMs?: number | undefined;
  uploadTimeoutMs?: number | undefined;
  /** Injection point for contract-test doubles; defaults to the global `fetch`. */
  fetchImpl?: HiggsfieldFetch | undefined;
  /** Static headers merged into JSON requests only (never the signed-URL PUT). */
  defaultHeaders?: Record<string, string> | undefined;
  /** Test seam for the response-size guard; defaults to 8 MiB. */
  maxResponseBytes?: number | undefined;
}

export interface HiggsfieldJsonRequestOptions {
  signal?: AbortSignal | undefined;
}

export interface HiggsfieldJsonPostOptions extends HiggsfieldJsonRequestOptions {
  idempotencyKey?: string | undefined;
  /** Exact query parameters, serialized in sorted-key order. */
  query?: Record<string, string> | undefined;
}

export interface HiggsfieldPutOptions {
  signal?: AbortSignal | undefined;
}

export interface HiggsfieldHttpResponse {
  status: number;
  /** Parsed JSON body, or `null` for an empty 2xx body. */
  json: unknown;
}

/**
 * The `fetch` signature the adapter depends on: the Node 22 global, or any
 * structurally identical implementation injected by tests. Named here so
 * consumers never publish a contract through `ReturnType`.
 */
export type HiggsfieldFetch = typeof globalThis.fetch;

/** Minimal response surface the client touches; satisfied by the global `Response`. */
export interface HiggsfieldFetchResponse {
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: { get(name: string): string | null };
}

export class HiggsfieldHttpClient {
  readonly baseUrl: string;

  private readonly authorizationValue: string;
  private readonly requestTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly fetchImpl: HiggsfieldFetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly maxResponseBytes: number;
  /** `/{endpoint_id}` paths of the bundled catalog; the only model paths constructible. */
  private readonly modelEndpointPaths: ReadonlySet<string>;
  /** True when the configured provider origin is itself a local/internal endpoint. */
  private readonly baseIsInternalOrigin: boolean;

  constructor(options: HiggsfieldHttpClientOptions) {
    const rawBaseUrl = options.baseUrl ?? HIGGSFIELD_API_BASE_URL;
    this.baseUrl = assertAbsoluteHttpUrl(rawBaseUrl, 'base URL').replace(/\/+$/, '');
    const parsedBase = new URL(this.baseUrl);
    if (parsedBase.search.length > 0 || parsedBase.hash.length > 0) {
      throw new GatewayError('INVALID_INPUT', 'The provider base URL must not carry a query string or fragment.');
    }
    // An operator who points the adapter at an internal endpoint (dev double,
    // sidecar proxy) opts that origin — and only that origin — into the signed
    // upload allowlist; a public endpoint gets the strict public-https rule.
    this.baseIsInternalOrigin = isBlockedHostname(parsedBase.hostname);
    const credential = options.credentials.credentials;
    if (typeof credential !== 'string' || credential.length === 0 || !HEADER_VALUE_PATTERN.test(credential)) {
      throw new GatewayError('AUTHENTICATION_FAILED', 'The configured provider credential is not a usable header value.');
    }
    // Normalize `<id>:<secret>` to the documented `Key <id>:<secret>` header form.
    this.authorizationValue = toAuthorizationValue(credential);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const defaultHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.defaultHeaders ?? {})) {
      if (name.toLowerCase() === 'authorization') {
        // Otherwise the credential would be sent twice; the client owns that header.
        throw new GatewayError('INVALID_INPUT', 'Default headers must not override the Authorization header.');
      }
      if (!HEADER_NAME_PATTERN.test(name) || !HEADER_VALUE_PATTERN.test(value)) {
        throw new GatewayError('INVALID_INPUT', 'Default headers contain an unusable name or value.');
      }
      defaultHeaders[name] = value;
    }
    this.defaultHeaders = Object.freeze(defaultHeaders);
    this.modelEndpointPaths = new Set(loadBundledCatalog().map((model) => `/${model.endpoint}`));
  }

  /**
   * Authorizes a request path: documented shape *and*, for model endpoints, an
   * endpoint that exists in the bundled catalog. A caller-supplied string can
   * therefore never reach an undocumented provider path.
   */
  private authorizePath(path: string): string {
    const safe = assertAllowedProviderPath(path);
    if (isFixedProviderPath(safe)) {
      if (safe.startsWith('/estimate/')) {
        // `/estimate` is documented only for catalog endpoint ids.
        const endpoint = safe.slice('/estimate'.length);
        if (!this.modelEndpointPaths.has(endpoint)) {
          throw new GatewayError('INVALID_INPUT', 'Refusing to estimate an undocumented provider endpoint.');
        }
      }
      return safe;
    }
    if (!this.modelEndpointPaths.has(safe)) {
      throw new GatewayError('INVALID_INPUT', 'Refusing to call an undocumented provider endpoint.');
    }
    return safe;
  }

  /** `GET {baseUrl}{path}`. `path` must be a documented provider path. */
  async get(path: string, options: HiggsfieldJsonRequestOptions = {}): Promise<HiggsfieldHttpResponse> {
    const safePath = this.authorizePath(path);
    return this.send({
      operation: this.operationForPath(safePath),
      method: 'GET',
      url: `${this.baseUrl}${safePath}`,
      headers: this.jsonHeaders(),
      timeoutMs: this.requestTimeoutMs,
      maxBytes: this.maxResponseBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  }

  /**
   * `POST {baseUrl}{path}` with `canonicalJson(body)` as the exact request bytes,
   * so an identical persisted body replays byte-identically. Pass `body`
   * `undefined` for the documented empty-body cancel call.
   */
  async post(
    path: string,
    body: unknown,
    options: HiggsfieldJsonPostOptions = {}
  ): Promise<HiggsfieldHttpResponse> {
    const safePath = this.authorizePath(path);
    const url = this.buildUrl(safePath, options.query);
    if (options.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(options.idempotencyKey)) {
      throw new GatewayError(
        'INVALID_INPUT',
        'The upstream idempotency key must be 1-255 visible ASCII characters without whitespace.'
      );
    }
    const headers = this.jsonHeaders();
    if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
    let bytes: Uint8Array | undefined;
    if (body !== undefined) {
      let text: string;
      try {
        text = canonicalJson(body);
      } catch (error) {
        throw new GatewayError('INVALID_INPUT', 'The provider request body is not JSON-serializable.', { cause: error });
      }
      bytes = UTF8_ENCODER.encode(text);
      headers['Content-Type'] = 'application/json';
    }
    return this.send({
      operation: this.operationForPath(safePath),
      method: 'POST',
      url,
      headers,
      timeoutMs: this.requestTimeoutMs,
      maxBytes: this.maxResponseBytes,
      ...(bytes === undefined ? {} : { body: bytes }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  }

  /**
   * `PUT` raw bytes to a provider-issued signed URL.
   *
   * Sends exactly the headers handed in (the documented `upload_headers` map)
   * and never the provider `Authorization` header, never default headers, and
   * never a redirect.
   */
  async put(
    url: string,
    bytes: Uint8Array,
    headers: Record<string, string>,
    options: HiggsfieldPutOptions = {}
  ): Promise<HiggsfieldHttpResponse> {
    const target = assertAbsoluteHttpUrl(url, 'signed upload URL');
    this.assertTrustedUploadTarget(target);
    const forwarded: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!HEADER_NAME_PATTERN.test(name) || !HEADER_VALUE_PATTERN.test(value)) {
        throw new ProviderHttpError('MEDIA_UPLOAD_FAILED', 'The provider returned an unusable upload header.', {
          operation: 'upload_put',
          status: 0
        });
      }
      forwarded[name] = value;
    }
    return this.send({
      operation: 'upload_put',
      method: 'PUT',
      url: target,
      headers: forwarded,
      body: bytes,
      timeoutMs: this.uploadTimeoutMs,
      maxBytes: UPLOAD_RESPONSE_MAX_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
  }

  /**
   * Provider-issued upload targets are as untrusted as caller URLs (SPEC §17): a
   * hostile ticket — or a proxy in front of the provider — must not be able to
   * make the gateway PUT media bytes to an internal address over plain http.
   *
   * - public provider origin: the target must be `https` and a non-internal host;
   * - internal provider origin (operator-configured): the target must be that same
   *   origin, so a dev double keeps working while a pivot to another internal
   *   address (metadata service, loopback, another private host) is still refused.
   */
  private assertTrustedUploadTarget(target: string): void {
    const parsed = new URL(target);
    if (this.baseIsInternalOrigin) {
      const base = new URL(this.baseUrl);
      if (parsed.origin !== base.origin) {
        throw this.untrustedUploadTarget('the operator-configured provider origin');
      }
      return;
    }
    if (parsed.protocol !== 'https:') throw this.untrustedUploadTarget('an https URL');
    if (isBlockedHostname(parsed.hostname)) throw this.untrustedUploadTarget('a public host');
  }

  /** Deterministic refusal: retrying the same ticket cannot fix it. */
  private untrustedUploadTarget(expectation: string): ProviderHttpError {
    return new ProviderHttpError(
      'MEDIA_UPLOAD_FAILED',
      `The provider signed upload URL must target ${expectation}.`,
      {
        operation: 'upload_put',
        status: 0,
        retryable: false,
        details: { reason: 'untrusted_upload_target' }
      }
    );
  }

  /**
   * Selects the operation label used for error mapping. Derived from the
   * documented path set, so callers cannot mislabel a failure.
   */
  private operationForPath(path: string): ProviderOperation {
    if (path.startsWith('/requests/')) return path.endsWith('/cancel') ? 'cancel' : 'status';
    if (path.startsWith('/estimate/')) return 'estimate';
    if (path === '/files/generate-upload-url') return 'upload_request';
    return 'submit';
  }

  /** `Authorization` is added here and nowhere else. */
  private jsonHeaders(): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: this.authorizationValue,
      ...this.defaultHeaders
    };
  }

  /** Serializes query parameters in sorted-key order; both parts are percent-encoded. */
  private buildUrl(path: string, query: Record<string, string> | undefined): string {
    if (query === undefined) return `${this.baseUrl}${path}`;
    const parts: string[] = [];
    for (const key of Object.keys(query).sort()) {
      const value = query[key];
      if (!QUERY_KEY_PATTERN.test(key) || typeof value !== 'string') {
        throw new GatewayError('INVALID_INPUT', 'Provider query parameters must be safe names with string values.');
      }
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
    if (parts.length === 0) return `${this.baseUrl}${path}`;
    return `${this.baseUrl}${path}?${parts.join('&')}`;
  }

  private async send(params: {
    operation: ProviderOperation;
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
    body?: Uint8Array | undefined;
    timeoutMs: number;
    maxBytes: number;
    signal?: AbortSignal | undefined;
  }): Promise<HiggsfieldHttpResponse> {
    const callerSignal = params.signal;
    if (callerSignal?.aborted === true) {
      throw new ProviderHttpError('CANCELLED', 'The Higgsfield request was cancelled.', {
        operation: params.operation,
        status: 0
      });
    }
    const controller = new AbortController();
    let timedOut = false;
    let abortedByCaller = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, params.timeoutMs);
    const onCallerAbort = (): void => {
      abortedByCaller = true;
      controller.abort();
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      let response: HiggsfieldFetchResponse;
      try {
        response = await this.fetchImpl(params.url, {
          method: params.method,
          headers: params.headers,
          redirect: 'manual',
          signal: controller.signal,
          ...(params.body === undefined ? {} : { body: params.body })
        });
      } catch (error) {
        throw mapProviderTransportError(error, {
          operation: params.operation,
          timedOut,
          abortedByCaller,
          url: params.url
        });
      }

      if (response.status >= 300 && response.status < 400) {
        if (response.body !== null) {
          try {
            await response.body.cancel();
          } catch {
            // The redirect body is irrelevant; a failed drain must not mask the error.
          }
        }
        throw mapProviderHttpError({
          operation: params.operation,
          status: response.status,
          detail: 'The provider answered with a redirect.',
          url: params.url
        });
      }

      const bytes = await readCappedBody(response, params.maxBytes, params);

      if (response.status < 200 || response.status >= 300) {
        let detail: string | undefined;
        if (bytes.byteLength > 0) {
          try {
            detail = extractProviderDetail(JSON.parse(UTF8_DECODER.decode(bytes)));
          } catch {
            // A non-JSON or unexpected error body is never surfaced verbatim.
            detail = undefined;
          }
        }
        throw mapProviderHttpError({
          operation: params.operation,
          status: response.status,
          ...(detail === undefined ? {} : { detail }),
          url: params.url,
          ...(response.headers.get('retry-after') === null
            ? {}
            : { retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')) }),
          ...(response.headers.get('x-correlation-id') === null
            ? {}
            : { correlationId: response.headers.get('x-correlation-id') ?? undefined })
        });
      }

      if (bytes.byteLength === 0) return { status: response.status, json: null };
      try {
        return { status: response.status, json: JSON.parse(UTF8_DECODER.decode(bytes)) };
      } catch {
        throw new ProviderHttpError('PROVIDER_ERROR', 'The provider returned a malformed JSON body.', {
          operation: params.operation,
          status: response.status,
          url: params.url
        });
      }
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

/** Reads a response body with a hard byte cap; aborts the stream once exceeded. */
async function readCappedBody(
  response: HiggsfieldFetchResponse,
  maxBytes: number,
  context: { operation: ProviderOperation; url: string }
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = next.value;
    if (chunk === undefined) continue;
    total += chunk.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The response is discarded either way.
      }
      throw new ProviderHttpError('PROVIDER_ERROR', 'The provider response exceeded the configured size cap.', {
        operation: context.operation,
        status: response.status,
        url: context.url
      });
    }
    chunks.push(chunk);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
