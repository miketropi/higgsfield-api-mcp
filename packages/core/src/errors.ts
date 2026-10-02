import type { ErrorCode, StructuredError } from './contracts.js';
import { sanitizeDetails } from './redact.js';

const RETRYABLE_CODES: Readonly<Record<ErrorCode, boolean>> = {
  AUTHENTICATION_FAILED: false,
  ACCESS_DENIED: false,
  INSUFFICIENT_CREDITS: false,
  INVALID_INPUT: false,
  MODEL_NOT_FOUND: false,
  MODEL_UNAVAILABLE: false,
  RATE_LIMITED: true,
  MEDIA_UPLOAD_FAILED: true,
  JOB_NOT_FOUND: false,
  JOB_FAILED: false,
  TIMEOUT: true,
  CANCELLED: false,
  COST_LIMIT_EXCEEDED: false,
  POLICY_REJECTED: false,
  PROVIDER_ERROR: true,
  INTERNAL_ERROR: true
};

/** HTTP status used when a gateway error must be expressed as an HTTP response. */
const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  AUTHENTICATION_FAILED: 401,
  ACCESS_DENIED: 403,
  INSUFFICIENT_CREDITS: 402,
  INVALID_INPUT: 400,
  MODEL_NOT_FOUND: 404,
  MODEL_UNAVAILABLE: 409,
  RATE_LIMITED: 429,
  MEDIA_UPLOAD_FAILED: 502,
  JOB_NOT_FOUND: 404,
  JOB_FAILED: 422,
  TIMEOUT: 504,
  CANCELLED: 409,
  COST_LIMIT_EXCEEDED: 402,
  POLICY_REJECTED: 403,
  PROVIDER_ERROR: 502,
  INTERNAL_ERROR: 500
};

export interface GatewayErrorOptions {
  retryable?: boolean | undefined;
  retryAfterMs?: number | undefined;
  details?: Record<string, unknown> | undefined;
  cause?: unknown;
}

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number | undefined;
  readonly details?: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: GatewayErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GatewayError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_CODES[code];
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    const details = options.details === undefined ? undefined : sanitizeDetails(options.details);
    if (details !== undefined) this.details = details;
  }

  toStructuredError(): StructuredError {
    return toStructuredError(this);
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

/**
 * Allowlisted error serialization. Never forwards raw SDK/HTTP objects, config
 * blobs, or Axios-style request objects.
 */
export function toStructuredError(error: unknown): StructuredError {
  if (error instanceof GatewayError) {
    const structured: StructuredError = {
      code: error.code,
      message: error.message,
      retryable: error.retryable
    };
    if (error.retryAfterMs !== undefined) structured.retryAfterMs = error.retryAfterMs;
    if (error.details !== undefined) structured.details = error.details;
    return structured;
  }
  if (error instanceof Error) {
    return {
      code: 'INTERNAL_ERROR',
      message: 'Unexpected gateway failure.',
      retryable: true,
      details: { kind: error.name }
    };
  }
  return { code: 'INTERNAL_ERROR', message: 'Unexpected gateway failure.', retryable: true };
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(HTTP_STATUS, value);
}
