import { mkdtempSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLocalFileReader } from '../../../packages/core/src/media/local-files.js';
import { createSilentLogger } from '../../fixtures/fakes.js';
import { PNG_BYTES } from './helpers.js';

/** Counts real `open()` calls so digest memoization is observable. */
const counters = vi.hoisted(() => ({ opens: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      counters.opens += 1;
      return await actual.open(...args);
    }
  };
});

const root = mkdtempSync(join(tmpdir(), 'hf-media-memo-'));
const path = join(root, 'image.png');
writeFileSync(path, PNG_BYTES);

const reader = createLocalFileReader({
  allowedPaths: [root],
  localFileAccess: true,
  maxBytes: 1024 * 1024,
  logger: createSilentLogger()
});

describe('identify digest memoization', () => {
  it('reads the file once across repeated identify calls', async () => {
    counters.opens = 0;
    const first = await reader.identify(path);
    const second = await reader.identify(path);
    const third = await reader.identify(path);

    expect(first.digest).toBe(second.digest);
    expect(second.digest).toBe(third.digest);
    expect(counters.opens).toBe(1);
  });

  it('re-reads after the file changes', async () => {
    counters.opens = 0;
    await reader.identify(path);
    writeFileSync(path, new Uint8Array([...PNG_BYTES, 0x00]));
    const updated = await reader.identify(path);

    expect(counters.opens).toBe(1);
    expect(updated.size).toBe(PNG_BYTES.byteLength + 1);
  });

  it('always re-reads for a real upload, never reusing the memoized digest', async () => {
    counters.opens = 0;
    await reader.identify(path);
    const source = await reader.read(path);
    expect(source.bytes.byteLength).toBe(PNG_BYTES.byteLength + 1);
    expect(counters.opens).toBe(1);
  });
});
