import type {
  Clock,
  ConfirmationRequired,
  GenerationJob,
  GenerationResult,
  GenerationService,
  JobService,
  LoggerPort,
  MediaAsset,
  MediaIdentity,
  MediaReference,
  MediaService,
  MetricsPort,
  ModelRegistry,
  ProviderFactory,
  RequestContext
} from '../contracts.js';
import { GatewayError } from '../errors.js';
import { canonicalJson, newId, newOpaqueToken, newUpstreamIdempotencyKey, sha256Hex } from '../ids.js';
import { safeUrlForLogging } from '../redact.js';
import type { JobRepository, SubmissionEnvelope, UsageReservation } from '../jobs/repository.js';
import type { Admission, AdmissionClass } from '../policies/admission.js';
import type { CostGuard } from '../policies/cost-guard.js';
import type { ConfirmationStore } from '../policies/confirmation.js';
import { routeRequest } from './router.js';
import { assertSafeProviderUrls, validateProviderInput } from './schema-validator.js';

/** Internal signal: another transaction claimed the same idempotency key first. */
class IdempotencyRaceLost extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super('idempotency key claimed by a concurrent request');
    this.name = 'IdempotencyRaceLost';
    this.jobId = jobId;
  }
}

export interface WebhookPlan {
  /** Absolute gateway callback URL, or undefined when webhooks are disabled. */
  callbackUrl(jobId: string, token: string): string | undefined;
  /**
   * True when a caller-supplied callback URL is gateway-owned (same origin and the
   * gateway's own webhook path). Arbitrary external callbacks are refused: the
   * gateway only ever notifies itself, with a per-job opaque token.
   */
  ownsUrl?(supplied: string): boolean;
}

export interface GenerationServiceOptions {
  repository: JobRepository;
  registry: ModelRegistry;
  providerFactory: ProviderFactory;
  media: MediaService;
  costGuard: CostGuard;
  confirmation: ConfirmationStore;
  jobs: JobService;
  clock: Clock;
  logger: LoggerPort;
  metrics: MetricsPort;
  wait: { defaultMs: number; maxMs: number };
  webhook?: WebhookPlan | undefined;
  /** Tenant/token/tool/provider admission limits (SPEC §38). */
  admission?: Admission | undefined;
}

const MEDIA_REFERENCE_TYPES = ['url', 'asset', 'file'];

function asMediaReference(value: unknown): MediaReference | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['type'] !== 'string' || !MEDIA_REFERENCE_TYPES.includes(candidate['type'])) return undefined;
  if (typeof candidate['url'] === 'string') return { type: 'url', url: candidate['url'] };
  const assetId = candidate['assetId'] ?? candidate['asset_id'];
  if (typeof assetId === 'string') return { type: 'asset', assetId };
  if (typeof candidate['path'] === 'string') return { type: 'file', path: candidate['path'] };
  return undefined;
}

function mapInput(
  value: unknown,
  transform: (reference: MediaReference) => unknown
): unknown {
  const reference = asMediaReference(value);
  if (reference !== undefined) return transform(reference);
  if (Array.isArray(value)) return value.map((item) => mapInput(item, transform));
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) out[key] = mapInput(item, transform);
    return out;
  }
  return value;
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function requireTenant(context: RequestContext): string {
  if (context.tenantId === undefined || context.tenantId.length === 0) {
    throw new GatewayError('INTERNAL_ERROR', 'Resolved request context has no tenant.');
  }
  return context.tenantId;
}

export function createGenerationService(options: GenerationServiceOptions): GenerationService {
  const thresholds = options.costGuard.thresholds;

  const resolveMedia = async (
    input: Record<string, unknown>,
    context: RequestContext
  ): Promise<Record<string, unknown>> => {
    const entries = await Promise.all(
      Object.entries(input).map(async ([key, value]) => [key, await resolveNested(value, context)] as const)
    );
    return Object.fromEntries(entries);
  };

  const resolveNested = async (value: unknown, context: RequestContext): Promise<unknown> => {
    const reference = asMediaReference(value);
    if (reference !== undefined) {
      const asset: MediaAsset = await options.media.resolve(reference, context);
      return asset.url;
    }
    if (Array.isArray(value)) {
      const items = await Promise.all(value.map((item) => resolveNested(item, context)));
      return items;
    }
    if (typeof value === 'object' && value !== null) {
      const source = value as Record<string, unknown>;
      const entries = await Promise.all(
        Object.entries(source).map(async ([key, item]) => [key, await resolveNested(item, context)] as const)
      );
      return Object.fromEntries(entries);
    }
    return value;
  };

  const collectIdentities = async (
    input: Record<string, unknown>,
    context: RequestContext
  ): Promise<MediaIdentity[]> => {
    const identities: MediaIdentity[] = [];
    const walk = async (value: unknown): Promise<void> => {
      const reference = asMediaReference(value);
      if (reference !== undefined) {
        identities.push(await options.media.identify(reference, context));
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) await walk(item);
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const item of Object.values(value as Record<string, unknown>)) await walk(item);
      }
    };
    await walk(input);
    return identities;
  };

  const hashIntent = (params: {
    tool: string;
    endpoint: string;
    model: string;
    input: Record<string, unknown>;
    workspaceId: string | undefined;
    identities: MediaIdentity[];
  }): string => {
    const identityQueue = [...params.identities];
    const normalized = mapInput(params.input, () => {
      const next = identityQueue.shift();
      return next === undefined ? 'media:unknown' : `media:${next.kind}:${next.id}`;
    });
    return sha256Hex(
      canonicalJson({
        tool: params.tool,
        endpoint: params.endpoint,
        model: params.model,
        workspaceId: params.workspaceId ?? null,
        input: normalized
      })
    );
  };

  return {
    async submit(tool, request, context): Promise<GenerationResult> {
      const tenantId = requireTenant(context);
      const workspaceId = request.workspaceId ?? context.workspaceId;
      const now = options.clock.now();
      const routed = routeRequest({
        tool,
        endpoint: request.endpoint,
        input: request.input,
        registry: options.registry
      });
        await options.admission?.admit({
        tool,
        class: admissionClassFor(routed.model.concurrencyClass),
        context,
        provider: options.providerFactory.providerId
      });
      const identities = await collectIdentities(routed.input, context);
      const requestHash = hashIntent({
        tool,
        endpoint: routed.endpoint,
        model: routed.model.id,
        input: routed.input,
        workspaceId,
        identities
      });

      if (request.idempotencyKey !== undefined) {
        const existing = await options.repository.transaction((tx) =>
          tx.getIdempotency(tenantId, tool, request.idempotencyKey as string)
        );
        if (existing !== undefined) {
          if (existing.requestHash !== requestHash) {
            throw new GatewayError(
              'INVALID_INPUT',
              'This idempotency_key was already used with different request parameters.',
              { details: { reason: 'idempotency_key_mismatch' } }
            );
          }
          const reused = await options.repository.transaction((tx) => tx.getJob(tenantId, existing.jobId));
          if (reused !== undefined) {
            options.logger.info(
              { event: 'generation.idempotent_reuse', job_id: reused.id, tool },
              'Reused existing job for idempotency key'
            );
            return request.wait === true
              ? options.jobs.wait(reused.id, options.wait.defaultMs, context)
              : reused;
          }
        }
      }

      const resolvedInput = await resolveMedia(routed.input, context);
      validateProviderInput(routed.model, resolvedInput);
      assertSafeProviderUrls(resolvedInput);

      const estimate = await options.costGuard.estimate({
        endpoint: routed.endpoint,
        input: resolvedInput,
        model: routed.model,
        context
      });
      const estimatedMicroUsd = estimate?.microUsd;
      if (estimatedMicroUsd === undefined && options.costGuard.enforced) {
        throw new GatewayError(
          'POLICY_REJECTED',
          `No documented cost is available for ${routed.endpoint} while cost limits are configured.`,
          { details: { endpoint: routed.endpoint, reason: 'cost_unknown' } }
        );
      }
      if (
        estimatedMicroUsd !== undefined &&
        thresholds.maxJobMicroUsd !== undefined &&
        estimatedMicroUsd > thresholds.maxJobMicroUsd
      ) {
        throw new GatewayError('COST_LIMIT_EXCEEDED', 'Estimated cost exceeds the per-job cost limit.', {
          details: { estimated_micro_usd: estimatedMicroUsd, limit_micro_usd: thresholds.maxJobMicroUsd }
        });
      }

      if (request.webhook !== undefined) {
        if (options.webhook === undefined) {
          throw new GatewayError('POLICY_REJECTED', 'Webhook callbacks are not enabled on this gateway.', {
            details: { reason: 'webhooks_disabled' }
          });
        }
        if (options.webhook.ownsUrl === undefined || !options.webhook.ownsUrl(request.webhook.url)) {
          throw new GatewayError(
            'POLICY_REJECTED',
            'A webhook callback URL must be this gateway\'s own callback endpoint.',
            { details: { reason: 'callback_url_not_gateway_owned' } }
          );
        }
      }

      const jobId = newId('job');
      const callbackToken = options.webhook === undefined ? undefined : newOpaqueToken(32);
      const callbackUrl =
        callbackToken === undefined || options.webhook === undefined
          ? undefined
          : options.webhook.callbackUrl(jobId, callbackToken);

      if (
        request.confirmationToken === undefined &&
        estimatedMicroUsd !== undefined &&
        thresholds.confirmAboveMicroUsd !== undefined &&
        estimatedMicroUsd > thresholds.confirmAboveMicroUsd
      ) {
        const created = await options.confirmation.create(
          { tenantId, tool, requestHash, estimatedMicroUsd },
          context
        );
        const required: ConfirmationRequired = {
          status: 'confirmation_required',
          estimatedCostUsd: estimatedMicroUsd / 1_000_000,
          confirmationToken: created.token,
          expiresAt: created.expiresAt
        };
        options.logger.info(
          { event: 'generation.confirmation_required', tool, endpoint: routed.endpoint },
          'Confirmation required before submission'
        );
        return required;
      }

      const provider = await options.providerFactory.forContext(context);
      const upstreamIdempotencyKey = newUpstreamIdempotencyKey();
      const plan = provider.prepare({
        endpoint: routed.endpoint,
        input: resolvedInput,
        upstreamIdempotencyKey,
        jobKind: routed.model.kind,
        ...(callbackUrl === undefined ? {} : { webhook: { url: callbackUrl } }),
        ...(workspaceId === undefined ? {} : { workspaceId })
      });

      const job: GenerationJob = {
        id: jobId,
        tenantId,
        provider: provider.id,
        capability: routed.capability,
        model: routed.model.id,
        endpoint: routed.endpoint,
        kind: routed.model.kind,
        status: 'queued',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        inputSummary: summarize(resolvedInput),
        assets: [],
        submissionState: 'pending',
        tool,
        concurrencyClass: routed.model.concurrencyClass,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(estimate === undefined
          ? {}
          : { cost: { currency: 'USD' as const, estimatedMicroUsd: estimate.microUsd, source: estimate.source, estimatedAt: estimate.estimatedAt } })
      };

      const envelope: SubmissionEnvelope = {
        jobId,
        tenantId,
        provider: provider.id,
        providerAccountId: provider.accountId,
        jobKind: routed.model.kind,
        concurrencyClass: routed.model.concurrencyClass,
        endpoint: plan.endpoint,
        upstreamIdempotencyKey,
        body: plan.body,
        bodyHash: plan.bodyHash,
        state: 'pending',
        attempts: 0,
        version: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      if (plan.webhook !== undefined) envelope.webhookUrl = plan.webhook.url;
      if (plan.query !== undefined) envelope.query = plan.query;
      if (callbackUrl !== undefined) envelope.webhookUrl = callbackUrl;
      if (callbackToken !== undefined) {
        envelope.callbackToken = callbackToken;
        envelope.callbackTokenHash = sha256Hex(callbackToken);
      }

      const admitted = await options.repository
        .transaction(async (tx) => {
        if (request.idempotencyKey !== undefined) {
          const claim = await tx.getIdempotency(tenantId, tool, request.idempotencyKey);
          if (claim !== undefined) {
            if (claim.requestHash !== requestHash) {
              throw new GatewayError(
                'INVALID_INPUT',
                'This idempotency_key was already used with different request parameters.',
                { details: { reason: 'idempotency_key_mismatch' } }
              );
            }
            return { jobId: claim.jobId, created: false as const };
          }
        }
        if (request.confirmationToken !== undefined) {
          const approved = await options.confirmation.consumeInTransaction(tx, {
            token: request.confirmationToken,
            tenantId,
            tool,
            requestHash
          });
          if (estimatedMicroUsd !== undefined && estimatedMicroUsd > approved.estimatedMicroUsd) {
            throw new GatewayError('POLICY_REJECTED', 'The price changed since this request was confirmed.', {
              details: {
                reason: 'price_increased',
                approved_micro_usd: approved.estimatedMicroUsd,
                current_micro_usd: estimatedMicroUsd
              }
            });
          }
        }
        if (estimatedMicroUsd !== undefined && thresholds.dailyLimitMicroUsd !== undefined) {
          const reserved = await tx.reservedMicroUsdForDay(tenantId, utcDay(now));
          if (reserved + estimatedMicroUsd > thresholds.dailyLimitMicroUsd) {
            throw new GatewayError('COST_LIMIT_EXCEEDED', 'Daily estimated cost limit would be exceeded.', {
              details: {
                reserved_micro_usd: reserved,
                estimated_micro_usd: estimatedMicroUsd,
                limit_micro_usd: thresholds.dailyLimitMicroUsd
              }
            });
          }
        }
        if (estimatedMicroUsd !== undefined) {
          const reservation: UsageReservation = {
            jobId,
            tenantId,
            day: utcDay(now),
            microUsd: estimatedMicroUsd,
            providerAccountId: 'unassigned',
            state: 'reserved',
            createdAt: now.toISOString()
          };
          await tx.reserveUsage(reservation);
          await tx.appendUsageEvent({
            id: `${jobId}:reserve`,
            tenantId,
            jobId,
            kind: 'reserve',
            microUsd: estimatedMicroUsd,
            at: now.toISOString()
          });
        }
        await tx.insertJob(job);
        await tx.putSubmission(envelope);
        if (request.idempotencyKey !== undefined) {
          const claim = await tx.putIdempotency({
            tenantId,
            tool,
            key: request.idempotencyKey,
            requestHash,
            jobId,
            createdAt: now.toISOString()
          });
          if (claim.jobId !== jobId) {
            // Another concurrent request won the key between our pre-check and this
            // claim. Abort this transaction so the loser leaves no job, reservation,
            // envelope or provider submission behind, then reuse the winner's job.
            throw new IdempotencyRaceLost(claim.jobId);
          }
        }
          return { jobId, created: true as const };
        })
        .catch((error: unknown) => {
          if (error instanceof IdempotencyRaceLost) return { jobId: error.jobId, created: false as const };
          throw error;
        });

      if (!admitted.created) {
        const reused = await options.repository.transaction((tx) => tx.getJob(tenantId, admitted.jobId));
        if (reused !== undefined) {
          return request.wait === true ? options.jobs.wait(reused.id, options.wait.defaultMs, context) : reused;
        }
      }

      options.metrics.queuedJobs(routed.model.concurrencyClass, 1);
      if (estimatedMicroUsd !== undefined) options.metrics.estimatedCostUsd(estimatedMicroUsd);
      options.logger.info(
        {
          event: 'generation.submitted',
          job_id: jobId,
          tool,
          endpoint: routed.endpoint,
          model: routed.model.id,
          provider: provider.id
        },
        'Generation job admitted'
      );

      return request.wait === true ? options.jobs.wait(jobId, options.wait.defaultMs, context) : job;
    }
  };
}

function admissionClassFor(concurrencyClass: 'image' | 'video' | 'other'): AdmissionClass {
  return concurrencyClass;
}

/** Public-safe request summary: never raw prompts, media bytes or provider URLs. */
function summarize(input: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      summary[key] = /url/i.test(key) ? safeUrlForLogging(value) : { length: value.length };
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      summary[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      summary[key] = { count: value.length };
      continue;
    }
    if (typeof value === 'object' && value !== null) summary[key] = { keys: Object.keys(value).slice(0, 8) };
  }
  return summary;
}
