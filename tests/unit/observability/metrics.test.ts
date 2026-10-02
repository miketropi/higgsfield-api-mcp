import { describe, expect, it } from 'vitest';
import { createMetrics } from '@higgsfield-mcp/observability';

const EXPECTED_METRICS = [
  'mcp_tool_calls_total',
  'mcp_tool_errors_total',
  'generation_jobs_total',
  'generation_job_duration_seconds',
  'provider_requests_total',
  'provider_errors_total',
  'media_upload_bytes_total',
  'estimated_cost_usd_total',
  'active_jobs',
  'queued_jobs'
];

function enabledMetrics(serviceName = 'higgsfield-mcp') {
  return createMetrics({ enabled: true, serviceName });
}

describe('createMetrics exposition', () => {
  it('declares every documented metric', async () => {
    const exposition = await enabledMetrics().render();
    for (const name of EXPECTED_METRICS) {
      expect(exposition, `${name} must be declared`).toContain(`# HELP ${name} `);
      expect(exposition, `${name} must have a type`).toMatch(new RegExp(`^# TYPE ${name} (counter|gauge|histogram)$`, 'm'));
    }
  });

  it('counts tool calls, errors, jobs, provider traffic, uploads, and cost', async () => {
    const metrics = enabledMetrics();
    metrics.toolCall('generate_image', 'http');
    metrics.toolError('generate_image', 'PROVIDER_UNAVAILABLE');
    metrics.jobStarted('higgsfield', 'image', 'generation');
    metrics.jobFinished('higgsfield', 'image', 'generation', 'completed', 12.5);
    metrics.providerRequest('higgsfield', 'generate', 'ok');
    metrics.providerError('higgsfield', 'RATE_LIMITED');
    metrics.mediaUploadBytes('in', 2048);
    metrics.estimatedCostUsd(2_500_000);

    const exposition = await metrics.render();
    expect(exposition).toMatch(/^mcp_tool_calls_total\{[^}]*tool="generate_image"[^}]*\} 1$/m);
    expect(exposition).toMatch(/^mcp_tool_errors_total\{[^}]*code="PROVIDER_UNAVAILABLE"[^}]*\} 1$/m);
    expect(exposition).toMatch(/^generation_jobs_total\{[^}]*capability="image"[^}]*\} 1$/m);
    expect(exposition).toMatch(/^generation_job_duration_seconds_count\{[^}]*status="completed"[^}]*\} 1$/m);
    expect(exposition).toMatch(/^generation_job_duration_seconds_sum\{[^}]*\} 12\.5$/m);
    expect(exposition).toMatch(/^provider_requests_total\{[^}]*outcome="ok"[^}]*\} 1$/m);
    expect(exposition).toMatch(/^provider_errors_total\{[^}]*\} 1$/m);
    expect(exposition).toMatch(/^media_upload_bytes_total\{[^}]*direction="in"[^}]*\} 2048$/m);
    expect(exposition).toMatch(/^estimated_cost_usd_total\{[^}]*\} 2\.5$/m);
  });

  it('moves the concurrency gauges in both directions', async () => {
    const metrics = enabledMetrics();
    metrics.activeJobs('image', 2);
    metrics.activeJobs('image', 1);
    metrics.activeJobs('image', -1);
    metrics.queuedJobs('video', 3);
    metrics.queuedJobs('video', -3);

    const exposition = await metrics.render();
    expect(exposition).toMatch(/^active_jobs\{[^}]*concurrency_class="image"[^}]*\} 2$/m);
    expect(exposition).toMatch(/^queued_jobs\{[^}]*concurrency_class="video"[^}]*\} 0$/m);
  });

  it('ignores values that would corrupt a counter or histogram', async () => {
    const metrics = enabledMetrics();
    metrics.mediaUploadBytes('in', -1);
    metrics.estimatedCostUsd(Number.NaN);
    metrics.jobFinished('higgsfield', 'image', 'generation', 'completed', Number.POSITIVE_INFINITY);
    metrics.providerRequest('higgsfield', 'generate', 'ok');

    const exposition = await metrics.render();
    // A labelled counter only materialises a series once it is incremented.
    expect(exposition).not.toMatch(/^media_upload_bytes_total\{/m);
    // prom-client always exposes the unlabelled counter; the rejected NaN leaves it at zero.
    expect(exposition).toMatch(/^estimated_cost_usd_total\{[^}]*\} 0$/m);
    // The infinite duration never reaches the histogram.
    expect(exposition).not.toMatch(/^generation_job_duration_seconds_(count|sum)\{/m);
    expect(exposition).toMatch(/^provider_requests_total\{[^}]*\} 1$/m);
  });
});

describe('label hygiene', () => {
  it('caps label length at 64 characters', async () => {
    const metrics = enabledMetrics();
    metrics.toolCall('a'.repeat(200), 'stdio');

    const exposition = await metrics.render();
    expect(exposition).toContain(`tool="${'a'.repeat(64)}"`);
    expect(exposition).not.toContain('a'.repeat(65));
  });

  it('strips characters outside the allowed set', async () => {
    const metrics = enabledMetrics();
    metrics.toolCall('Generate Image!\n/../${x}', 'stdio');

    const exposition = await metrics.render();
    expect(exposition).toContain('tool="GenerateImage..x"');
  });

  it('rejects hostile values instead of letting them multiply series', async () => {
    const metrics = enabledMetrics();
    const hostile = 'tenant-42-token-abc-https://evil.example.com/?x=1';
    metrics.providerRequest('higgsfield', hostile, 'ok');
    metrics.mediaUploadBytes('sideways' as unknown as 'in' | 'out', 1);
    metrics.toolCall('generate_image', 'carrier-pigeon' as unknown as 'stdio' | 'http');

    const exposition = await metrics.render();
    expect(exposition).not.toContain('evil.example.com/?x=1');
    expect(exposition).toContain('direction="in"');
    expect(exposition).toContain('transport="stdio"');
  });

  it('tags every series with the service name', async () => {
    const metrics = enabledMetrics('gateway-edge');
    metrics.toolCall('generate_image', 'stdio');
    expect(await metrics.render()).toContain('service="gateway-edge"');
  });

  it('sanitizes the service name too', async () => {
    const metrics = enabledMetrics('gateway edge/{bad}');
    expect(await metrics.render()).toBeTypeOf('string');
    expect(await metrics.render()).toContain('service="gatewayedgebad"');
  });
});

describe('disabled metrics', () => {
  it('produces an empty exposition and exposes the content type', async () => {
    const metrics = createMetrics({ enabled: false, serviceName: 'higgsfield-mcp' });
    metrics.toolCall('generate_image', 'stdio');
    metrics.toolError('generate_image', 'INTERNAL_ERROR');
    metrics.jobStarted('higgsfield', 'image', 'generation');
    metrics.jobFinished('higgsfield', 'image', 'generation', 'completed', 1);
    metrics.providerRequest('higgsfield', 'generate', 'ok');
    metrics.providerError('higgsfield', 'INTERNAL_ERROR');
    metrics.mediaUploadBytes('out', 10);
    metrics.estimatedCostUsd(1_000_000);
    metrics.activeJobs('image', 1);
    metrics.queuedJobs('image', 1);

    expect(await metrics.render()).toBe('');
    expect(metrics.contentType).toContain('text/plain');
  });

  it('reports the prometheus content type when enabled', () => {
    expect(enabledMetrics().contentType).toBe('text/plain; version=0.0.4; charset=utf-8');
  });
});
