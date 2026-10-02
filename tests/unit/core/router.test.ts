import { describe, expect, it } from 'vitest';
import { GatewayError, createModelRegistry } from '@higgsfield-mcp/core';
import { TEST_CATALOG } from '../../fixtures/fakes.js';
import { createTestStack, submitJob } from '../../fixtures/stack.js';

describe('semantic routing', () => {
  it('routes image.default to the documented Grok endpoint and maps quality', async () => {
    const stack = createTestStack();
    const job = await submitJob(stack, 'higgsfield.generate_image', {
      endpoint: 'image.default',
      input: { prompt: 'a lighthouse', quality: 'draft', aspect_ratio: '16:9' }
    });
    const envelope = await stack.repository.transaction((tx) => tx.getSubmission('tenant-a', job.id));
    expect(envelope?.endpoint).toBe('xai/grok-imagine-image-2.0');
    expect(envelope?.body).toEqual({ prompt: 'a lighthouse', quality: 'low', aspect_ratio: '16:9' });
  });

  it('rejects a semantic feature that has no documented equivalent instead of dropping it', async () => {
    const stack = createTestStack();
    await expect(
      stack.generation.submit(
        'higgsfield.generate_image',
        { endpoint: 'image.default', input: { prompt: 'x', quality: 'high' } },
        { requestId: 'req_1', tenantId: 'tenant-a', transport: 'stdio' }
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      stack.generation.submit(
        'higgsfield.animate_image',
        { endpoint: 'video.image_to_video', input: { image: { type: 'url', url: 'https://x/y.png' }, prompt: 'x', camera_motion: 'pan' } },
        { requestId: 'req_1', tenantId: 'tenant-a', transport: 'stdio' }
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('requires the explicit model override to support every requested capability', async () => {
    const stack = createTestStack();
    await expect(
      stack.generation.submit(
        'higgsfield.generate_video',
        {
          endpoint: 'video.default',
          input: {
            prompt: 'x',
            start_image: { type: 'url', url: 'https://cdn.example.com/a.png' },
            end_image: { type: 'url', url: 'https://cdn.example.com/b.png' },
            model: 'kling-video/v2.5-turbo/pro/image-to-video'
          }
        },
        { requestId: 'req_1', tenantId: 'tenant-a', transport: 'stdio' }
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('selects the Seedance endpoint when an end frame is requested', async () => {
    const stack = createTestStack();
    const job = await submitJob(stack, 'higgsfield.generate_video', {
      endpoint: 'video.default',
      input: {
        prompt: 'x',
        start_image: { type: 'url', url: 'https://cdn.example.com/a.png' },
        end_image: { type: 'url', url: 'https://cdn.example.com/b.png' },
        resolution: '1080p'
      }
    });
    const envelope = await stack.repository.transaction((tx) => tx.getSubmission('tenant-a', job.id));
    expect(envelope?.endpoint).toBe('bytedance/seedance-2.5/image-to-video');
    expect(envelope?.body['end_image_url']).toBe('https://cdn.example.com/b.png');
  });

  it('honours an operator alias for a semantic route', () => {
    const registry = createModelRegistry({
      models: TEST_CATALOG,
      aliases: { 'image.default': 'alibaba/qwen-image-3/edit' }
    });
    expect(registry.aliases()['image.default']).toBe('alibaba/qwen-image-3/edit');
    expect(registry.resolve('image.default', 'image_edit').id).toBe('alibaba/qwen-image-3/edit');
  });

  it('accepts the documented provider endpoint id for a native submission', async () => {
    const stack = createTestStack();
    // The registry registers this model as `soul-id` while the provider (and the
    // generated skill) address it as `v1/custom-references`; both must resolve.
    const job = await submitJob(stack, 'higgsfield.generate', {
      endpoint: 'v1/custom-references',
      input: {
        name: 'My character',
        model_version: 'v2',
        input_images: [{ type: 'image_url', image_url: 'https://cdn.example.com/portrait.png' }]
      }
    });
    const envelope = await stack.repository.transaction((tx) => tx.getSubmission('tenant-a', job.id));
    expect(envelope?.endpoint).toBe('v1/custom-references');
    expect(envelope?.jobKind).toBe('custom_reference');
    expect(job.model).toBe('soul-id');

    const byId = await submitJob(stack, 'higgsfield.generate', {
      endpoint: 'soul-id',
      input: {
        name: 'My character',
        model_version: 'v2',
        input_images: [{ type: 'image_url', image_url: 'https://cdn.example.com/portrait.png' }]
      }
    });
    expect(byId.model).toBe('soul-id');
  });

  it('fails closed on an unknown model and on an unregistered native endpoint', () => {
    const registry = createModelRegistry({ models: TEST_CATALOG });
    expect(() => registry.get('nope')).toThrow(GatewayError);
    expect(() => registry.resolve('nope', 'image_generation')).toThrow(GatewayError);
  });
});
