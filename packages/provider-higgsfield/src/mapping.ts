/**
 * Provider value translation: lifecycle status, USD amounts, failure reasons.
 *
 * Every enum and field name here is taken from the official docs
 * (https://docs.higgsfield.ai/docs/concepts/requests.md for statuses,
 * https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md for the
 * estimate response, https://docs.higgsfield.ai/docs/models/soul-id/create-character.md
 * for custom-reference statuses). Nothing is inferred.
 */
import { GatewayError } from '@higgsfield-mcp/core';
import type { JobStatus, StructuredError } from '@higgsfield-mcp/core';
import { sanitizeProviderMessage } from './errors.js';

/** Documented `RequestStatus.status` values, spelled exactly as returned. */
export const DOCUMENTED_REQUEST_STATUSES = [
  'queued',
  'in_progress',
  'completed',
  'failed',
  'nsfw',
  'canceled'
] as const;
export type DocumentedRequestStatus = (typeof DOCUMENTED_REQUEST_STATUSES)[number];

/** Documented custom-reference statuses (Soul ID training). */
export const DOCUMENTED_CUSTOM_REFERENCE_STATUSES = [
  'not_ready',
  'queued',
  'in_progress',
  'completed',
  'failed'
] as const;
export type DocumentedCustomReferenceStatus = (typeof DOCUMENTED_CUSTOM_REFERENCE_STATUSES)[number];

export interface MappedProviderStatus {
  status: JobStatus;
  known: boolean;
  raw: string;
}

const REQUEST_STATUS_MAP: Readonly<Record<DocumentedRequestStatus, JobStatus>> = {
  queued: 'queued',
  in_progress: 'processing',
  completed: 'completed',
  failed: 'failed',
  // `nsfw` is terminal; the caller maps the failure to POLICY_REJECTED.
  nsfw: 'failed',
  canceled: 'cancelled'
};

const CUSTOM_REFERENCE_STATUS_MAP: Readonly<Record<DocumentedCustomReferenceStatus, JobStatus>> = {
  // `not_ready` means training has not been accepted yet; it is never terminal.
  not_ready: 'queued',
  queued: 'queued',
  in_progress: 'processing',
  completed: 'completed',
  failed: 'failed'
};

/**
 * Maps a `RequestStatus.status` value onto the public job status union.
 *
 * An unrecognised status maps to non-terminal `processing` with `known: false`:
 * a provider that grows a new state must never be reported to a caller as
 * finished or failed.
 */
export function mapProviderStatus(raw: string): MappedProviderStatus {
  const mapped: JobStatus | undefined = Object.hasOwn(REQUEST_STATUS_MAP, raw)
    ? REQUEST_STATUS_MAP[raw as DocumentedRequestStatus]
    : undefined;
  return mapped === undefined ? { status: 'processing', known: false, raw } : { status: mapped, known: true, raw };
}

/** Same contract as `mapProviderStatus`, for the Soul ID training lifecycle. */
export function mapCustomReferenceStatus(raw: string): MappedProviderStatus {
  const mapped: JobStatus | undefined = Object.hasOwn(CUSTOM_REFERENCE_STATUS_MAP, raw)
    ? CUSTOM_REFERENCE_STATUS_MAP[raw as DocumentedCustomReferenceStatus]
    : undefined;
  return mapped === undefined ? { status: 'processing', known: false, raw } : { status: mapped, known: true, raw };
}

const MICRO_EXPONENT = 6;
const MICRO_PER_USD = 1_000_000;
const DECIMAL_PATTERN = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const MAX_DECIMAL_TEXT_LENGTH = 64;
const MAX_EXPONENT = 40;

/**
 * Parses a documented decimal-string USD amount into integer micro-USD using
 * exact decimal arithmetic (BigInt), never floating point:
 * `"0.084"` → `84000`, `"8.40"` → `8400000`, `"0.000001"` → `1`.
 *
 * Amounts that cannot be represented exactly in micro-USD (more than six
 * significant decimal places) are rejected rather than rounded; silently
 * rounding money is worse than failing.
 */
export function parseUsdToMicroUsd(value: string | number): number {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new GatewayError('PROVIDER_ERROR', 'Provider returned a non-numeric USD amount.');
  }
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_DECIMAL_TEXT_LENGTH) {
    throw new GatewayError('PROVIDER_ERROR', 'Provider returned a non-numeric USD amount.');
  }
  const match = DECIMAL_PATTERN.exec(text);
  if (match === null) {
    throw new GatewayError('PROVIDER_ERROR', 'Provider returned a non-numeric USD amount.');
  }
  const exponent = match[5] === undefined ? 0 : Number(match[5]);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT) {
    throw new GatewayError('PROVIDER_ERROR', 'Provider returned a USD amount outside the supported range.');
  }
  const fraction = match[3] ?? match[4] ?? '';
  const digits = BigInt(`${match[2] ?? ''}${fraction}` || '0');
  // value = digits / 10 ** scale, where scale is the decimal-place shift.
  const scale = fraction.length - exponent;
  let microUsd: bigint;
  if (scale <= MICRO_EXPONENT) {
    microUsd = digits * 10n ** BigInt(MICRO_EXPONENT - scale);
  } else {
    const divisor = 10n ** BigInt(scale - MICRO_EXPONENT);
    if (digits % divisor !== 0n) {
      throw new GatewayError('PROVIDER_ERROR', 'Provider returned a USD amount with sub-micro-USD precision.');
    }
    microUsd = digits / divisor;
  }
  if (match[1] === '-') microUsd = -microUsd;
  if (microUsd > BigInt(Number.MAX_SAFE_INTEGER) || microUsd < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new GatewayError('PROVIDER_ERROR', 'Provider returned a USD amount outside the supported range.');
  }
  return Number(microUsd);
}

/** Inverse of `parseUsdToMicroUsd` for operator-facing display only. */
export function microUsdToUsd(microUsd: number): number {
  if (!Number.isSafeInteger(microUsd)) {
    throw new GatewayError('INTERNAL_ERROR', 'Micro-USD amounts must be safe integers.');
  }
  return microUsd / MICRO_PER_USD;
}

export interface ProviderFailureInput {
  /** Documented provider status (`failed`, `nsfw`). */
  status?: string | undefined;
  /** Documented `error` field of a terminal request. */
  error?: unknown;
  /** Documented `fail_reason` field of a failed custom reference. */
  failReason?: unknown;
}

/**
 * Maps a documented terminal provider failure onto a `StructuredError`.
 *
 * `failed` → `JOB_FAILED`; `nsfw` (content moderation) → `POLICY_REJECTED`.
 * Non-terminal statuses produce `undefined`: the caller keeps polling.
 */
export function toProviderFailure(input: ProviderFailureInput): StructuredError | undefined {
  const raw = input.status;
  if (raw !== 'failed' && raw !== 'nsfw') return undefined;
  const detail = sanitizeProviderMessage(input.error) ?? sanitizeProviderMessage(input.failReason);
  const code = raw === 'nsfw' ? 'POLICY_REJECTED' : 'JOB_FAILED';
  return {
    code,
    message:
      detail ??
      (raw === 'nsfw'
        ? 'The provider rejected this request under its content policy.'
        : 'The provider reported that the generation failed.'),
    retryable: false,
    details: { providerStatus: raw }
  };
}
