/**
 * Provider failure translation (SPEC §32).
 *
 * Higgsfield has no machine-readable error code: failures are identified by HTTP
 * status plus a human-readable `detail` string (docs.higgsfield.ai/docs/concepts/errors.md).
 * This module is the only place that decides a `GatewayError` code, so the
 * mapping is auditable and testable in one table.
 *
 * Nothing here may echo credentials, signed URLs, upload headers or raw response
 * bodies: messages carry at most the provider's own `detail` text (bounded,
 * whitespace-collapsed) and details carry the status/operation/correlation id.
 */
import { GatewayError, safeUrlForLogging } from '@higgsfield-mcp/core';
import type { ErrorCode } from '@higgsfield-mcp/core';

/** Which provider call failed; selectors differ per operation. */
export type ProviderOperation =
  | 'submit'
  | 'status'
  | 'cancel'
  | 'upload_request'
  | 'upload_put'
  | 'estimate';

export interface ProviderHttpErrorContext {
  operation: ProviderOperation;
  status: number;
  /** Provider `detail` text, already extracted and bounded. */
  detail?: string | undefined;
  /** Absolute request URL; only its credential-free form is retained. */
  url?: string | undefined;
  correlationId?: string | undefined;
  retryAfterMs?: number | undefined;
  /** Overrides the code default; used for refusals that retrying cannot fix. */
  retryable?: boolean | undefined;
  /** Extra machine-readable context; always passed through `sanitizeDetails`. */
  details?: Record<string, unknown> | undefined;
}

/**
 * A `GatewayError` that additionally exposes the HTTP status and operation, so
 * callers can distinguish documented outcomes (e.g. `400` from the cancel
 * endpoint means "processing already started") from genuine failures.
 */
export class ProviderHttpError extends GatewayError {
  readonly status: number;
  readonly operation: ProviderOperation;

  constructor(code: ErrorCode, message: string, context: ProviderHttpErrorContext) {
    super(code, message, {
      retryAfterMs: context.retryAfterMs,
      ...(context.retryable === undefined ? {} : { retryable: context.retryable }),
      details: {
        providerStatus: context.status,
        operation: context.operation,
        ...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
        ...(context.url === undefined ? {} : { url: safeUrlForLogging(context.url) }),
        ...(context.detail === undefined ? {} : { providerDetail: context.detail }),
        ...(context.details ?? {})
      }
    });
    this.name = 'ProviderHttpError';
    this.status = context.status;
    this.operation = context.operation;
  }
}

const MAX_DETAIL_LENGTH = 400;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

/** Collapses whitespace and bounds provider-supplied failure text. */
export function sanitizeProviderMessage(value: unknown, maxLength = MAX_DETAIL_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed;
}

/**
 * Extracts the documented FastAPI error envelope: `{ "detail": string }`, where
 * validation failures may instead be a list of objects with a `msg` field.
 */
export function extractProviderDetail(body: unknown): string | undefined {
  if (typeof body === 'string') return sanitizeProviderMessage(body);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const detail = (body as Record<string, unknown>)['detail'];
  if (typeof detail === 'string') return sanitizeProviderMessage(detail);
  if (Array.isArray(detail)) {
    const parts: string[] = [];
    for (const item of detail) {
      if (item === null || typeof item !== 'object') continue;
      const message = sanitizeProviderMessage((item as Record<string, unknown>)['msg'], 120);
      if (message !== undefined) parts.push(message);
      if (parts.length >= 5) break;
    }
    if (parts.length > 0) return sanitizeProviderMessage(parts.join('; '));
  }
  return undefined;
}

/** Documented concurrency rejection text: "Maximum number of concurrent requests (4) has been reached". */
const CONCURRENCY_DETAIL = /maximum number of concurrent requests|too many concurrent|concurrency limit/i;
const IDEMPOTENCY_DETAIL = /idempotency[- ]key/i;
const MODEL_STATE_DETAIL = /model is (?:blocked|disabled|not ready)|temporarily blocked|not ready|unavailable/i;

/**
 * Maps one provider HTTP failure to a `GatewayError` (SPEC §32).
 *
 * Documented statuses (docs.higgsfield.ai/docs/concepts/errors.md):
 * `400` invalid parameters or concurrency reached, `401` missing/invalid
 * credentials, `403` insufficient credits, `404` request or model not found,
 * `422` validation failed or idempotency key reused with different parameters,
 * `423` model temporarily blocked, `503` model disabled or not ready, `500`
 * unexpected server error. `429`/`Retry-After` are not published by the
 * provider but are still honoured if the edge emits them.
 */
export function mapProviderHttpError(context: ProviderHttpErrorContext): ProviderHttpError {
  const { status, operation, detail } = context;
  const suffix = detail === undefined ? '' : `: ${detail}`;
  const make = (code: ErrorCode, text: string): ProviderHttpError =>
    new ProviderHttpError(code, `${text}${suffix}`, context);

  if (operation === 'upload_put') {
    return make(
      'MEDIA_UPLOAD_FAILED',
      status >= 300 && status < 400
        ? 'The signed upload target redirected; refusing to follow.'
        : 'Uploading bytes to the provider signed URL failed.'
    );
  }

  if (status >= 300 && status < 400) {
    return make('PROVIDER_ERROR', 'The provider returned a redirect; refusing to follow it.');
  }

  switch (status) {
    case 400:
      if (detail !== undefined && CONCURRENCY_DETAIL.test(detail)) {
        return make('RATE_LIMITED', 'Provider concurrency limit reached.');
      }
      return make('INVALID_INPUT', 'The provider rejected the request parameters.');
    case 401:
      return make('AUTHENTICATION_FAILED', 'Higgsfield rejected the configured credentials.');
    case 403:
      return make('INSUFFICIENT_CREDITS', 'Higgsfield account has insufficient credits.');
    case 404:
      if (operation === 'status' || operation === 'cancel') {
        return make('JOB_NOT_FOUND', 'The provider request was not found for this account.');
      }
      return make('MODEL_NOT_FOUND', 'The provider endpoint was not found for this account.');
    case 422:
      if (detail !== undefined && IDEMPOTENCY_DETAIL.test(detail)) {
        return make('INVALID_INPUT', 'The upstream idempotency key was already used with different parameters.');
      }
      return make('INVALID_INPUT', 'The provider rejected the request during validation.');
    case 423:
      return make('MODEL_UNAVAILABLE', 'The provider reports the model as temporarily blocked.');
    case 429:
      return make('RATE_LIMITED', 'The provider rate-limited the request.');
    case 503:
      if (operation === 'upload_request') {
        return make('MEDIA_UPLOAD_FAILED', 'The provider upload service is temporarily unavailable.');
      }
      if (detail !== undefined && MODEL_STATE_DETAIL.test(detail)) {
        return make('MODEL_UNAVAILABLE', 'The provider reports the model as disabled or not ready.');
      }
      return make('PROVIDER_ERROR', 'The provider is temporarily unavailable.');
    default:
      if (status >= 500) {
        return make(
          operation === 'upload_request' ? 'MEDIA_UPLOAD_FAILED' : 'PROVIDER_ERROR',
          'The provider failed while handling the request.'
        );
      }
      return make('PROVIDER_ERROR', 'The provider returned an unexpected response.');
  }
}

/** Translator for `fetch` rejections: timeouts, caller aborts and transport faults. */
export function mapProviderTransportError(
  error: unknown,
  context: { operation: ProviderOperation; timedOut: boolean; abortedByCaller: boolean; url?: string | undefined }
): ProviderHttpError {
  const name = error instanceof Error ? error.name : 'UnknownError';
  if (context.timedOut) {
    return new ProviderHttpError('TIMEOUT', 'The Higgsfield request exceeded its configured timeout.', {
      operation: context.operation,
      status: 0,
      ...(context.url === undefined ? {} : { url: context.url })
    });
  }
  if (context.abortedByCaller) {
    return new ProviderHttpError('CANCELLED', 'The Higgsfield request was cancelled.', {
      operation: context.operation,
      status: 0
    });
  }
  return new ProviderHttpError('PROVIDER_ERROR', 'The Higgsfield request failed before a response was received.', {
    operation: context.operation,
    status: 0,
    details: { transportError: name },
    ...(context.url === undefined ? {} : { url: context.url })
  });
}

/**
 * `Retry-After` parsing: delta-seconds or an HTTP date. The provider does not
 * publish the header today, but a proxy in front of it may.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}
