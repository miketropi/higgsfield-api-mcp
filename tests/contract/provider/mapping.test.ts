/**
 * Contract tests for the pure translation helpers: provider status → public
 * status, decimal USD strings → micro-USD, provider failure → `StructuredError`.
 */
import { describe, expect, it } from 'vitest';
import {
  DOCUMENTED_CUSTOM_REFERENCE_STATUSES,
  DOCUMENTED_REQUEST_STATUSES,
  mapCustomReferenceStatus,
  mapProviderStatus,
  microUsdToUsd,
  parseUsdToMicroUsd,
  toProviderFailure
} from '@higgsfield-mcp/provider-higgsfield';
import type { JobStatus } from '@higgsfield-mcp/core';

const TERMINAL: JobStatus[] = ['completed', 'failed', 'cancelled'];

describe('mapProviderStatus', () => {
  const documented: Array<[string, JobStatus]> = [
    ['queued', 'queued'],
    ['in_progress', 'processing'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['nsfw', 'failed'],
    ['canceled', 'cancelled']
  ];

  it.each(documented)('maps the documented status %s to %s', (raw, expected) => {
    expect(mapProviderStatus(raw)).toEqual({ status: expected, known: true, raw });
  });

  it.each(['processing', 'succeeded', 'done', '', 'IN_PROGRESS'])(
    'keeps the undocumented status %s non-terminal and flags it as unknown',
    (raw) => {
      const mapped = mapProviderStatus(raw);
      expect(mapped.known).toBe(false);
      expect(mapped.raw).toBe(raw);
      expect(TERMINAL).not.toContain(mapped.status);
    }
  );

  it('documents the status vocabulary it was transcribed from', () => {
    expect(DOCUMENTED_REQUEST_STATUSES).toEqual(['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled']);
    expect(DOCUMENTED_CUSTOM_REFERENCE_STATUSES).toEqual([
      'not_ready',
      'queued',
      'in_progress',
      'completed',
      'failed'
    ]);
  });
});

describe('mapCustomReferenceStatus', () => {
  it.each([
    ['not_ready', 'queued'],
    ['queued', 'queued'],
    ['in_progress', 'processing'],
    ['completed', 'completed'],
    ['failed', 'failed']
  ] as Array<[string, JobStatus]>)('maps the Soul ID status %s to %s', (raw, expected) => {
    expect(mapCustomReferenceStatus(raw)).toEqual({ status: expected, known: true, raw });
  });

  it('keeps an undocumented Soul ID status non-terminal', () => {
    const mapped = mapCustomReferenceStatus('training');
    expect(mapped.known).toBe(false);
    expect(TERMINAL).not.toContain(mapped.status);
  });
});

describe('parseUsdToMicroUsd', () => {
  it.each([
    ['0.084', 84000],
    ['8.40', 8400000],
    ['0.000001', 1],
    ['12', 12000000],
    ['1.500', 1500000],
    ['0.094', 94000],
    ['0', 0],
    ['.5', 500000],
    ['1e-3', 1000],
    ['0.1', 100000],
    ['0.2', 200000]
  ] as Array<[string, number]>)('parses %s exactly as %d micro-USD', (input, expected) => {
    expect(parseUsdToMicroUsd(input)).toBe(expected);
  });

  it('parses numeric input produced by the same decimal value', () => {
    expect(parseUsdToMicroUsd(0.094)).toBe(94000);
    expect(parseUsdToMicroUsd(12)).toBe(12000000);
  });

  it('does not incur floating point drift on values that cannot be summed exactly', () => {
    expect(parseUsdToMicroUsd('0.1') + parseUsdToMicroUsd('0.2')).toBe(300000);
  });

  it.each(['abc', '', 'USD 1.00', '1.2.3', '0x10', '1,000'])('rejects the non-numeric amount %j', (input) => {
    expect(() => parseUsdToMicroUsd(input)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_ERROR' })
    );
  });

  it('rejects amounts with sub-micro-USD precision rather than rounding', () => {
    expect(() => parseUsdToMicroUsd('1.2345678')).toThrowError(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
    expect(() => parseUsdToMicroUsd('0.0000005')).toThrowError(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
  });

  it('rejects non-finite numbers', () => {
    expect(() => parseUsdToMicroUsd(Number.NaN)).toThrowError(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
    expect(() => parseUsdToMicroUsd(Number.POSITIVE_INFINITY)).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_ERROR' })
    );
  });
});

describe('microUsdToUsd', () => {
  it('converts integer micro-USD back to USD', () => {
    expect(microUsdToUsd(84000)).toBe(0.084);
    expect(microUsdToUsd(1)).toBe(0.000001);
    expect(microUsdToUsd(0)).toBe(0);
  });

  it('rejects non-integer micro-USD', () => {
    expect(() => microUsdToUsd(1.5)).toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });
});

describe('toProviderFailure', () => {
  it('maps a moderated (nsfw) request to POLICY_REJECTED', () => {
    expect(toProviderFailure({ status: 'nsfw' })).toMatchObject({
      code: 'POLICY_REJECTED',
      retryable: false,
      details: { providerStatus: 'nsfw' }
    });
  });

  it('maps a failed request to JOB_FAILED and keeps the provider message', () => {
    expect(toProviderFailure({ status: 'failed', error: 'Generation failed' })).toMatchObject({
      code: 'JOB_FAILED',
      message: 'Generation failed',
      retryable: false
    });
  });

  it('sanitizes provider failure text', () => {
    const failure = toProviderFailure({ status: 'failed', error: 'boom\n\t  now  ' });
    expect(failure?.message).toBe('boom now');
  });

  it('falls back to a generic message when the provider sends none', () => {
    expect(toProviderFailure({ status: 'failed' })?.message).toMatch(/generation failed/i);
  });

  it('maps a failed Soul ID training to JOB_FAILED using fail_reason', () => {
    expect(toProviderFailure({ status: 'failed', failReason: 'too few usable images' })).toMatchObject({
      code: 'JOB_FAILED',
      message: 'too few usable images'
    });
  });

  it('returns undefined for non-terminal statuses', () => {
    expect(toProviderFailure({ status: 'queued', error: 'ignored' })).toBeUndefined();
    expect(toProviderFailure({ status: 'in_progress' })).toBeUndefined();
    expect(toProviderFailure({})).toBeUndefined();
  });
});
