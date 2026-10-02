import { describe, expect, it } from 'vitest';
import { createTestStack, submitJob } from '../../fixtures/stack.js';

const request = (): { endpoint: string; input: Record<string, unknown> } => ({
  endpoint: 'image.default',
  input: { prompt: 'a lighthouse' }
});

describe('job service wait semantics', () => {
  it('treats timeout_ms 0 as an immediate read instead of the default budget', async () => {
    const stack = createTestStack();
    const job = await submitJob(stack, 'higgsfield.generate_image', request());
    const startedAt = Date.now();
    const result = await stack.jobs.wait(job.id, 0, { requestId: 'req', tenantId: 'tenant-a', transport: 'stdio' });
    expect(result.id).toBe(job.id);
    expect(result.status).toBe('queued');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('returns the still-running job on timeout without cancelling it', async () => {
    const stack = createTestStack();
    const job = await submitJob(stack, 'higgsfield.generate_image', request());
    const result = await stack.jobs.wait(job.id, 250, { requestId: 'req', tenantId: 'tenant-a', transport: 'stdio' });
    expect(result.status).toBe('queued');
    const stored = await stack.repository.transaction((tx) => tx.getJob('tenant-a', job.id));
    expect(stored?.status).toBe('queued');
  });

  it('returns a terminal job as soon as it is terminal', async () => {
    const stack = createTestStack();
    const job = await submitJob(stack, 'higgsfield.generate_image', request());
    await stack.worker.runOnce();
    stack.clock.advance(30_000);
    await stack.worker.runOnce();
    const result = await stack.jobs.wait(job.id, 250, { requestId: 'req', tenantId: 'tenant-a', transport: 'stdio' });
    expect(result.status).toBe('completed');
  });
});
