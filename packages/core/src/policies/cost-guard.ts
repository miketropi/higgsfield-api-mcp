import type {
  Clock,
  CostEstimate,
  LoggerPort,
  ModelDefinition,
  ProviderFactory,
  RequestContext
} from '../contracts.js';

export interface CostThresholds {
  /** `HF_MCP_MAX_JOB_COST_USD` in micro-USD. */
  maxJobMicroUsd?: number | undefined;
  /** `HF_MCP_DAILY_COST_LIMIT_USD` in micro-USD (per tenant, UTC day). */
  dailyLimitMicroUsd?: number | undefined;
  /** `HF_MCP_REQUIRE_CONFIRM_ABOVE_USD` in micro-USD. */
  confirmAboveMicroUsd?: number | undefined;
}

export interface CostEstimateRequest {
  endpoint: string;
  input: Record<string, unknown>;
  model?: ModelDefinition | undefined;
  context: RequestContext;
}

export interface CostGuard {
  readonly thresholds: CostThresholds;
  /** True when any cost control is active; unknown pricing is then fatal. */
  readonly enforced: boolean;
  /** Returns undefined only when pricing is genuinely unknown. */
  estimate(request: CostEstimateRequest): Promise<CostEstimate | undefined>;
}

export interface CostGuardOptions {
  providerFactory: ProviderFactory;
  thresholds: CostThresholds;
  clock: Clock;
  logger: LoggerPort;
}

/**
 * Pricing resolution: operator price overrides on the registry entry first (these
 * serve endpoints without an estimate API, notably Soul training), then the
 * provider's documented estimate endpoint. Never invents a price.
 */
export function createCostGuard(options: CostGuardOptions): CostGuard {
  const thresholds = options.thresholds;
  const enforced =
    thresholds.maxJobMicroUsd !== undefined ||
    thresholds.dailyLimitMicroUsd !== undefined ||
    thresholds.confirmAboveMicroUsd !== undefined;

  return {
    thresholds,
    enforced,

    async estimate(request: CostEstimateRequest): Promise<CostEstimate | undefined> {
      const override = request.model?.pricing;
      if (override?.unitMicroUsd !== undefined) {
        return {
          microUsd: override.unitMicroUsd,
          currency: 'USD',
          source: 'operator_override',
          endpoint: request.endpoint,
          estimatedAt: options.clock.now().toISOString()
        };
      }
      const provider = await options.providerFactory.forContext(request.context);
      if (provider.estimateCost === undefined) return undefined;
      try {
        return await provider.estimateCost({
          endpoint: request.endpoint,
          input: request.input
        });
      } catch (error) {
        options.logger.warn(
          { event: 'cost.estimate_failed', endpoint: request.endpoint, err: String((error as Error)?.name ?? 'Error') },
          'Cost estimate failed'
        );
        return undefined;
      }
    }
  };
}

export function usdToMicroUsd(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.round(value * 1_000_000);
}

export function microUsdToUsd(microUsd: number): number {
  return microUsd / 1_000_000;
}

export function formatMicroUsd(microUsd: number): string {
  return (microUsd / 1_000_000).toFixed(6);
}
