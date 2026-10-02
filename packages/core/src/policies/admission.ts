import type { LoggerPort, RateLimitDecision, RateLimitDimension, RateLimitRule, RateLimiter, RequestContext } from '../contracts.js';
import { GatewayError } from '../errors.js';

/** Admission class used to pick the per-tenant rule for a call. */
export type AdmissionClass = 'image' | 'video' | 'other' | 'upload' | 'read';

export interface AdmissionRules {
  /** Applied to every admitted call (tenant + token admission cap). */
  global: RateLimitRule;
  /** Per-tenant generation/upload ceilings, by class. */
  perClass: Record<AdmissionClass, RateLimitRule>;
  /** Optional per-tool ceilings, keyed by the MCP tool name. */
  perTool?: Record<string, RateLimitRule> | undefined;
  /** Optional aggregate ceiling per provider account. */
  provider?: RateLimitRule | undefined;
}

export interface AdmissionRequest {
  tool: string;
  class: AdmissionClass;
  context: RequestContext;
  /** Provider id when it is already resolved (generation paths). */
  provider?: string | undefined;
}

export interface Admission {
  /** Throws `RATE_LIMITED` with `retryAfterMs` when any dimension refuses. */
  admit(request: AdmissionRequest): Promise<RateLimitDecision>;
}

export interface AdmissionOptions {
  limiter: RateLimiter;
  rules: AdmissionRules;
  logger: LoggerPort;
  /**
   * Remote admissions fail closed when the limiter is unavailable; local (stdio)
   * deployments keep working because their limiter cannot be unreachable.
   */
  failClosed: boolean;
}

/**
 * Builds the dimension set for one call. Every dimension is evaluated before any
 * counter is consumed, so a refusal never burns quota on the other dimensions.
 */
export function buildDimensions(request: AdmissionRequest, rules: AdmissionRules): RateLimitDimension[] {
  const { context } = request;
  const tenant = context.tenantId ?? 'local';
  const tokenId = context.auth?.tokenId ?? tenant;
  const dimensions: RateLimitDimension[] = [
    { dimension: 'global', key: `${tenant}:${tokenId}`, rule: rules.global },
    { dimension: 'tenant', key: tenant, rule: rules.perClass[request.class] }
  ];
  const toolRule = rules.perTool?.[request.tool];
  if (toolRule !== undefined) dimensions.push({ dimension: 'tool', key: request.tool, rule: toolRule });
  if (rules.provider !== undefined && request.provider !== undefined) {
    dimensions.push({ dimension: 'provider', key: request.provider, rule: rules.provider });
  }
  return dimensions;
}

export function createAdmission(options: AdmissionOptions): Admission {
  return {
    async admit(request: AdmissionRequest): Promise<RateLimitDecision> {
      const dimensions = buildDimensions(request, options.rules);
      let decision: RateLimitDecision;
      try {
        decision = await options.limiter.check(dimensions);
      } catch (error) {
        if (options.failClosed) {
          throw new GatewayError('RATE_LIMITED', 'Admission is closed because the rate limiter is unavailable.', {
            retryable: true,
            details: { component: 'rate_limiter' }
          });
        }
        options.logger.warn(
          { event: 'admission.limiter_unavailable', tool: request.tool },
          'Rate limiter unavailable; local mode admits without limiting'
        );
        return { allowed: true };
      }
      if (decision.allowed) return decision;
      throw new GatewayError('RATE_LIMITED', `Rate limit reached for ${request.tool}.`, {
        retryAfterMs: decision.retryAfterMs,
        details: { limited_by: decision.limitedBy ?? 'unknown', tool: request.tool }
      });
    }
  };
}
