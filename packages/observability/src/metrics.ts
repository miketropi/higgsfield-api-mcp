import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { MetricsPort } from '@higgsfield-mcp/core';

/**
 * Prometheus surface for the gateway. `MetricsPort` is the frozen core
 * contract; `render` and `contentType` are the exposition endpoints the HTTP
 * layer serves at `/metrics`.
 */
export interface GatewayMetrics extends MetricsPort {
  render(): Promise<string>;
  readonly contentType: string;
}

/** Anything outside this set is stripped before a value reaches a label. */
const LABEL_DISALLOWED = /[^A-Za-z0-9_.:-]/g;
const MAX_LABEL_LENGTH = 64;

/** Caps label cardinality growth and keeps the exposition format unbreakable. */
function label(value: string): string {
  return value.replace(LABEL_DISALLOWED, '').slice(0, MAX_LABEL_LENGTH);
}

const noop = (): void => {};

/** Generation runs from a few seconds (images) to minutes (video). */
const JOB_DURATION_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800];

/**
 * Builds the process metrics. When `enabled` is false every method is a no-op
 * and `render()` returns an empty exposition, so callers never branch on
 * whether metrics are on.
 */
export function createMetrics(options: { enabled: boolean; serviceName: string }): GatewayMetrics {
  const registry = new Registry();

  if (!options.enabled) {
    return {
      toolCall: noop,
      toolError: noop,
      jobStarted: noop,
      jobFinished: noop,
      providerRequest: noop,
      providerError: noop,
      mediaUploadBytes: noop,
      estimatedCostUsd: noop,
      activeJobs: noop,
      queuedJobs: noop,
      render: async () => '',
      contentType: registry.contentType
    };
  }

  registry.setDefaultLabels({ service: label(options.serviceName) });

  const toolCalls = new Counter<'tool' | 'transport'>({
    name: 'mcp_tool_calls_total',
    help: 'MCP tool invocations by tool name and transport.',
    labelNames: ['tool', 'transport'],
    registers: [registry]
  });
  const toolErrors = new Counter<'tool' | 'code'>({
    name: 'mcp_tool_errors_total',
    help: 'MCP tool failures by tool name and structured error code.',
    labelNames: ['tool', 'code'],
    registers: [registry]
  });
  const jobsStarted = new Counter<'provider' | 'capability' | 'job_kind'>({
    name: 'generation_jobs_total',
    help: 'Generation jobs started by provider, capability, and job kind.',
    labelNames: ['provider', 'capability', 'job_kind'],
    registers: [registry]
  });
  const jobDuration = new Histogram<'provider' | 'capability' | 'job_kind' | 'status'>({
    name: 'generation_job_duration_seconds',
    help: 'Generation job wall-clock duration in seconds by terminal status.',
    labelNames: ['provider', 'capability', 'job_kind', 'status'],
    buckets: JOB_DURATION_BUCKETS,
    registers: [registry]
  });
  const providerRequests = new Counter<'provider' | 'endpoint' | 'outcome'>({
    name: 'provider_requests_total',
    help: 'Provider HTTP requests by endpoint identifier and outcome.',
    labelNames: ['provider', 'endpoint', 'outcome'],
    registers: [registry]
  });
  const providerErrors = new Counter<'provider' | 'code'>({
    name: 'provider_errors_total',
    help: 'Provider failures by provider and mapped error code.',
    labelNames: ['provider', 'code'],
    registers: [registry]
  });
  const uploadBytes = new Counter<'direction'>({
    name: 'media_upload_bytes_total',
    help: 'Media bytes uploaded to and downloaded from the provider.',
    labelNames: ['direction'],
    registers: [registry]
  });
  const costUsd = new Counter({
    name: 'estimated_cost_usd_total',
    help: 'Cumulative estimated generation cost in US dollars.',
    registers: [registry]
  });
  const activeJobs = new Gauge<'concurrency_class'>({
    name: 'active_jobs',
    help: 'Generation jobs currently executing, by concurrency class.',
    labelNames: ['concurrency_class'],
    registers: [registry]
  });
  const queuedJobs = new Gauge<'concurrency_class'>({
    name: 'queued_jobs',
    help: 'Generation jobs waiting for a concurrency slot, by concurrency class.',
    labelNames: ['concurrency_class'],
    registers: [registry]
  });

  return {
    toolCall: (tool, transport) => {
      toolCalls.inc({ tool: label(tool), transport: transport === 'http' ? 'http' : 'stdio' });
    },
    toolError: (tool, code) => {
      toolErrors.inc({ tool: label(tool), code: label(code) });
    },
    jobStarted: (provider, capability, jobKind) => {
      jobsStarted.inc({ provider: label(provider), capability: label(capability), job_kind: label(jobKind) });
    },
    jobFinished: (provider, capability, jobKind, status, durationSeconds) => {
      // prom-client throws on non-finite values, and a negative duration would
      // corrupt the histogram.
      if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return;
      jobDuration.observe(
        { provider: label(provider), capability: label(capability), job_kind: label(jobKind), status: label(status) },
        durationSeconds
      );
    },
    providerRequest: (provider, endpoint, outcome) => {
      providerRequests.inc({ provider: label(provider), endpoint: label(endpoint), outcome: outcome === 'ok' ? 'ok' : 'error' });
    },
    providerError: (provider, code) => {
      providerErrors.inc({ provider: label(provider), code: label(code) });
    },
    mediaUploadBytes: (direction, bytes) => {
      if (!Number.isFinite(bytes) || bytes < 0) return;
      uploadBytes.inc({ direction: direction === 'out' ? 'out' : 'in' }, bytes);
    },
    estimatedCostUsd: (microUsd) => {
      if (!Number.isFinite(microUsd) || microUsd < 0) return;
      costUsd.inc(microUsd / 1_000_000);
    },
    activeJobs: (concurrencyClass, delta) => {
      adjustGauge(activeJobs, label(concurrencyClass), delta);
    },
    queuedJobs: (concurrencyClass, delta) => {
      adjustGauge(queuedJobs, label(concurrencyClass), delta);
    },
    render: () => registry.metrics(),
    contentType: registry.contentType
  };
}

/** Counters cannot decrease, so a negative delta becomes a gauge decrement. */
function adjustGauge(gauge: Gauge<'concurrency_class'>, concurrencyClass: string, delta: number): void {
  if (!Number.isFinite(delta) || delta === 0) return;
  if (delta > 0) gauge.inc({ concurrency_class: concurrencyClass }, delta);
  else gauge.dec({ concurrency_class: concurrencyClass }, -delta);
}
