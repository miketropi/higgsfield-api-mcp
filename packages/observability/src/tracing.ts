import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { TraceContext } from '@higgsfield-mcp/core';

export interface TracingOptions {
  /** `OTEL_EXPORTER_OTLP_ENDPOINT`; tracing stays off when absent. */
  otlpEndpoint?: string | undefined;
  serviceName: string;
}

export interface TracingHandle {
  shutdown(): Promise<void>;
}

/**
 * Starts OTLP trace export. Returns `undefined` when no endpoint is configured
 * (the `@opentelemetry/api` no-op tracer keeps working) and never throws: a
 * misconfigured collector must not stop the gateway from serving MCP.
 */
export async function initTracing(options: TracingOptions): Promise<TracingHandle | undefined> {
  const endpoint = options.otlpEndpoint?.trim();
  if (endpoint === undefined || endpoint === '') return undefined;

  // The only process.env mutation in this package: the SDK reads the service
  // name from the environment, and `serviceName` is the documented default.
  process.env['OTEL_SERVICE_NAME'] = options.serviceName;

  try {
    const sdk = new NodeSDK({
      serviceName: options.serviceName,
      traceExporter: new OTLPTraceExporter({ url: endpoint })
    });
    sdk.start();
    return {
      shutdown: async () => {
        try {
          await sdk.shutdown();
        } catch {
          // An unreachable collector or a broken exporter must not fail shutdown.
        }
      }
    };
  } catch {
    return undefined;
  }
}

/** Trace identifiers for the active span, or `undefined` when none is active. */
export function currentTraceContext(): TraceContext | undefined {
  const span = trace.getActiveSpan();
  if (span === undefined) return undefined;
  const spanContext = span.spanContext();
  if (!trace.isSpanContextValid(spanContext)) return undefined;
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}
