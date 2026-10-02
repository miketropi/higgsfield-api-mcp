import type { JobRepository, LoggerPort, MetricsPort } from '@higgsfield-mcp/core';
import { digestEquals, sha256Hex } from '@higgsfield-mcp/core';

export interface WebhookRequest {
  method: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
  /** Bytes received, used to enforce the 64 KiB bound before parsing. */
  bodyBytes?: number | undefined;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
}

/** The hint handler the HTTP transport mounts at `/webhooks/higgsfield`. */
export type WebhookHandler = (request: WebhookRequest) => Promise<WebhookResponse>;

export interface WebhookHandlerOptions {
  repository: JobRepository;
  logger: LoggerPort;
  metrics: MetricsPort;
  /** Nudges the worker to reconcile one job immediately. */
  nudge: (jobId: string) => void;
  publicUrl?: string | undefined;
  maxBodyBytes?: number | undefined;
  perTokenPerMinute?: number | undefined;
  now?: (() => number) | undefined;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_PER_TOKEN_PER_MINUTE = 60;

/**
 * Higgsfield does not document a webhook signature or shared secret, so a
 * notification is only ever treated as an untrusted hint:
 *  - the exact per-job callback token authorizes nothing but "go look at this job";
 *  - caller-supplied status, ids and URLs are ignored entirely;
 *  - replay resistance comes from token entropy, coalescing, and idempotent terminal
 *    processing, not from a timestamp we cannot verify.
 */
export function createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const perMinute = options.perTokenPerMinute ?? DEFAULT_PER_TOKEN_PER_MINUTE;
  const now = options.now ?? Date.now;
  const counters = new Map<string, number[]>();

  const withinRate = (tokenHash: string): boolean => {
    const window = counters.get(tokenHash) ?? [];
    const cutoff = now() - 60_000;
    const kept = window.filter((at) => at > cutoff);
    if (kept.length >= perMinute) {
      counters.set(tokenHash, kept);
      return false;
    }
    kept.push(now());
    counters.set(tokenHash, kept);
    return true;
  };

  return async function handleWebhook(request: WebhookRequest): Promise<WebhookResponse> {
    if (request.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
    if ((request.bodyBytes ?? 0) > maxBodyBytes) return { status: 413, body: { error: 'payload_too_large' } };

    const token = request.query['token'];
    if (token === undefined || token.length === 0 || token.length > 512) {
      return { status: 404, body: undefined };
    }
    const tokenHash = sha256Hex(token);
    if (!withinRate(tokenHash)) {
      options.logger.warn({ event: 'webhook.rate_limited' }, 'Webhook notifications are arriving too quickly');
      return { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '30' } };
    }

    const envelope = await options.repository.transaction((tx) => tx.findSubmissionByCallbackTokenHash(tokenHash));
    if (envelope === undefined || envelope.callbackTokenHash === undefined) {
      options.logger.warn({ event: 'webhook.unknown_token' }, 'Rejected a webhook notification with an unknown token');
      return { status: 404, body: undefined };
    }
    if (!digestEquals(envelope.callbackTokenHash, tokenHash)) {
      return { status: 404, body: undefined };
    }

    options.metrics.providerRequest(envelope.provider, 'webhook', 'ok');
    options.logger.info(
      { event: 'webhook.received', job_id: envelope.jobId },
      'Webhook hint accepted; provider status remains authoritative'
    );
    options.nudge(envelope.jobId);
    return { status: 202, body: undefined };
  };
}
