import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { currentTraceContext, initTracing, type TracingHandle } from '@higgsfield-mcp/observability';

/** Connection refused immediately; nothing is ever exported to a real collector. */
const DEAD_ENDPOINT = 'http://127.0.0.1:1/v1/traces';

let handle: TracingHandle | undefined;

beforeAll(async () => {
  handle = await initTracing({ otlpEndpoint: DEAD_ENDPOINT, serviceName: 'gateway-test' });
});

afterAll(async () => {
  await handle?.shutdown();
});

describe('initTracing', () => {
  it('stays disabled without an endpoint', async () => {
    expect(await initTracing({ serviceName: 'higgsfield-mcp' })).toBeUndefined();
  });

  it('sets OTEL_SERVICE_NAME from the service name', () => {
    expect(process.env['OTEL_SERVICE_NAME']).toBe('gateway-test');
  });

  it('reports trace identifiers for the active span', () => {
    const span = trace.getTracer('observability-test').startSpan('unit');
    const active = context.with(trace.setSpan(context.active(), span), () => currentTraceContext());
    span.end();

    expect(active?.traceId).toHaveLength(32);
    expect(active?.spanId).toHaveLength(16);
  });
});

describe('currentTraceContext', () => {
  it('is undefined when no span is active', () => {
    expect(currentTraceContext()).toBeUndefined();
  });
});
