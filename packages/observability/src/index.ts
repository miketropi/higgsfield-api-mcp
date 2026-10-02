/**
 * `@higgsfield-mcp/observability` — logging, metrics, and tracing adapters.
 *
 * All three are thin ports: core services depend on `LoggerPort`,
 * `MetricsPort`, and `TraceContext`, never on pino, prom-client, or the
 * OpenTelemetry SDK.
 */
export { createLogger, describePrettySupport } from './logger.js';
export type { LoggerOptions } from './logger.js';

export { createMetrics } from './metrics.js';
export type { GatewayMetrics } from './metrics.js';

export { currentTraceContext, initTracing } from './tracing.js';
export type { TracingHandle, TracingOptions } from './tracing.js';
