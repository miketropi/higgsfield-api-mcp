import { describe, expect, it } from 'vitest';
import { GatewayError } from '@higgsfield-mcp/core';
import { createTestStack, submitJob } from '../../fixtures/stack.js';

const imageRequest = (): { endpoint: string; input: Record<string, unknown> } => ({
  endpoint: 'image.default',
  input: { prompt: 'a lighthouse' }
});

const videoRequest = (): { endpoint: string; input: Record<string, unknown> } => ({
  endpoint: 'video.default',
  input: { prompt: 'a slow pan' }
});

describe('submission worker', () => {
  it('submits once, acknowledges, then completes with a materialized asset and settled usage', async () => {
    const stack = createTestStack({
      provider: {
        estimateMicroUsd: 90_000,
        pollResults: [
          { providerJobId: 'generation:1', status: 'processing', assets: [] },
          {
            providerJobId: 'generation:1',
            status: 'completed',
            assets: [{ url: 'https://cdn.example.com/out.png', mediaType: 'image', mimeType: 'image/png', size: 10 }],
            cost: { currency: 'USD', actualMicroUsd: 88_000, source: 'estimate_api' }
          }
        ]
      }
    });
    const job = await submitJob(stack, 'higgsfield.generate_image', imageRequest());
    const first = await stack.worker.runOnce();
    expect(first.submitted).toBe(1);
    expect(stack.provider.submitCount()).toBe(1);

    const acknowledged = await stack.repository.transaction((tx) => tx.getJob('tenant-a', job.id));
    expect(acknowledged?.submissionState).toBe('acknowledged');
    expect(acknowledged?.providerJobId).toBeDefined();

    stack.clock.advance(3_000);
    const second = await stack.worker.runOnce();
    expect(second.completed).toBe(1);

    const completed = await stack.repository.transaction((tx) => tx.getJob('tenant-a', job.id));
    expect(completed?.status).toBe('completed');
    expect(completed?.assets).toHaveLength(1);
    expect(completed?.assets[0]?.url).toBe('https://cdn.example.com/out.png');
    expect(completed?.cost?.actualMicroUsd).toBe(88_000);

    const reservation = await stack.repository.transaction((tx) => tx.getReservation(job.id));
    expect(reservation?.state).toBe('settled');
    expect(reservation?.settledMicroUsd).toBe(88_000);

    const third = await stack.worker.runOnce();
    expect(third.completed).toBe(0);
    expect(stack.provider.submitCount()).toBe(1);
  });

  it('replays the identical key and body after an ambiguous transient failure', async () => {
    const stack = createTestStack({
      provider: {
        idempotencySupport: 'documented',
        submitResults: [
          new GatewayError('PROVIDER_ERROR', 'connection reset'),
          { providerJobId: 'generation:9', status: 'queued', assets: [] }
        ],
        pollResults: [{ providerJobId: 'generation:9', status: 'processing', assets: [] }]
      }
    });
    const job = await submitJob(stack, 'higgsfield.generate_image', imageRequest());
    const first = await stack.worker.runOnce();
    expect(first.replayScheduled).toBe(1);
    const ambiguous = await stack.repository.transaction((tx) => tx.getSubmission('tenant-a', job.id));
    expect(ambiguous?.state).toBe('submitting');
    expect(ambiguous?.nextAttemptAt).toBeDefined();

    stack.clock.advance(60_000);
    const second = await stack.worker.runOnce();
    expect(second.submitted).toBe(1);

    const submits = stack.provider.calls.filter((call) => call.kind === 'submit');
    expect(submits).toHaveLength(2);
    expect(submits[0]?.upstreamIdempotencyKey).toBe(submits[1]?.upstreamIdempotencyKey);
    expect(submits[0]?.bodyHash).toBe(submits[1]?.bodyHash);
    expect(submits[0]?.body).toEqual(submits[1]?.body);
  });

  it('never replays an ambiguous submission on an endpoint without an idempotency guarantee', async () => {
    const stack = createTestStack({
      provider: {
        idempotencySupport: 'unknown',
        estimateMicroUsd: 90_000,
        submitResults: [new GatewayError('PROVIDER_ERROR', 'gateway timeout')]
      }
    });
    const job = await submitJob(stack, 'higgsfield.generate_image', imageRequest());
    const first = await stack.worker.runOnce();
    expect(first.unknownOutcome).toBe(1);
    const ambiguous = await stack.repository.transaction((tx) => tx.getJob('tenant-a', job.id));
    expect(ambiguous?.status).toBe('processing');
    expect(ambiguous?.error?.code).toBe('PROVIDER_ERROR');

    stack.clock.advance(120_000);
    await stack.worker.runOnce();
    expect(stack.provider.submitCount()).toBe(1);
    const reservation = await stack.repository.transaction((tx) => tx.getReservation(job.id));
    expect(reservation?.state).toBe('reserved');
  });

  it('fails the job and releases the reservation when the provider refuses before acceptance', async () => {
    const stack = createTestStack({
      provider: { estimateMicroUsd: 90_000, submitResults: [new GatewayError('AUTHENTICATION_FAILED', 'bad key')] }
    });
    const job = await submitJob(stack, 'higgsfield.generate_image', imageRequest());
    const result = await stack.worker.runOnce();
    expect(result.rejected).toBe(1);
    const failed = await stack.repository.transaction((tx) => tx.getJob('tenant-a', job.id));
    expect(failed?.status).toBe('failed');
    expect(failed?.error?.code).toBe('AUTHENTICATION_FAILED');
    const reservation = await stack.repository.transaction((tx) => tx.getReservation(job.id));
    expect(reservation?.state).toBe('released');
  });

  it('cancellation before submission prevents the provider POST', async () => {
    const stack = createTestStack();
    const job = await submitJob(stack, 'higgsfield.generate_image', imageRequest());
    const cancelled = await stack.jobs.cancel(job.id, { requestId: 'req_1', tenantId: 'tenant-a', transport: 'stdio' });
    expect(cancelled.status).toBe('cancelled');
    const result = await stack.worker.runOnce();
    expect(result.claimed).toBe(0);
    expect(stack.provider.submitCount()).toBe(0);
  });

  it('does not fail a job when a poll fails transiently and respects the slot ceiling', async () => {
    const stack = createTestStack({
      provider: {
        pollResults: [new GatewayError('PROVIDER_ERROR', 'temporary outage'), { providerJobId: 'generation:5', status: 'processing', assets: [] }]
      },
      worker: { maxPerClass: { image: 1, video: 1, other: 1 } }
    });
    const first = await submitJob(stack, 'higgsfield.generate_image', imageRequest());
    await submitJob(stack, 'higgsfield.generate_image', imageRequest());
    const tick = await stack.worker.runOnce();
    expect(tick.claimed).toBe(1);
    expect(stack.provider.submitCount()).toBe(1);

    stack.clock.advance(5_000);
    const second = await stack.worker.runOnce();
    expect(second.submitted).toBe(1);
    const job = await stack.repository.transaction((tx) => tx.getJob('tenant-a', first.id));
    expect(['queued', 'processing']).toContain(job?.status ?? '');
  });

  it('reconciles non-terminal jobs on startup', async () => {
    const stack = createTestStack({
      provider: {
        pollResults: [
          { providerJobId: 'generation:7', status: 'processing', assets: [] },
          {
            providerJobId: 'generation:7',
            status: 'completed',
            assets: [{ url: 'https://cdn.example.com/reconciled.png', mediaType: 'image', mimeType: 'image/png' }]
          }
        ]
      }
    });
    await submitJob(stack, 'higgsfield.generate_image', imageRequest());
    await stack.worker.runOnce();
    stack.clock.advance(5_000);
    const reconciled = await stack.worker.reconcileOnStartup();
    expect(reconciled.polled).toBeGreaterThanOrEqual(1);
    expect(reconciled.completed).toBe(1);
  });

  it('counts video submissions against the video slot ceiling', async () => {
    const stack = createTestStack({ worker: { maxPerClass: { image: 5, video: 1, other: 1 } } });
    await submitJob(stack, 'higgsfield.generate_video', videoRequest());
    const tick = await stack.worker.runOnce();
    expect(tick.claimed).toBe(1);
    const job = await stack.repository.transaction((tx) => tx.listJobs('tenant-a', { limit: 5 }));
    expect(job.jobs[0]?.concurrencyClass).toBe('video');
  });
});
