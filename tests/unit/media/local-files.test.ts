import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../packages/core/src/ids.js';
import { createLocalFileReader, type LocalFileReader } from '../../../packages/core/src/media/local-files.js';
import { createSilentLogger } from '../../fixtures/fakes.js';
import { expectGatewayError, PNG_BYTES, TEXT_BYTES } from './helpers.js';

const root = mkdtempSync(join(tmpdir(), 'hf-media-root-'));
const outside = mkdtempSync(join(tmpdir(), 'hf-media-outside-'));

writeFileSync(join(root, 'image.png'), PNG_BYTES);
writeFileSync(join(root, 'notes.txt'), TEXT_BYTES);
writeFileSync(join(root, 'empty.png'), new Uint8Array());
writeFileSync(join(outside, 'secret.png'), PNG_BYTES);
mkdirSync(join(root, 'nested'));
writeFileSync(join(root, 'nested', 'deep.png'), PNG_BYTES);
symlinkSync(join(outside, 'secret.png'), join(root, 'escape.png'));
symlinkSync(join(root, 'image.png'), join(root, 'self-link.png'));
mkdirSync(join(root, 'directory.png'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function reader(overrides: Partial<Parameters<typeof createLocalFileReader>[0]> = {}): LocalFileReader {
  return createLocalFileReader({
    allowedPaths: [root],
    localFileAccess: true,
    maxBytes: 1024 * 1024,
    logger: createSilentLogger(),
    ...overrides
  });
}

describe('local file allowlist', () => {
  it('reads a file inside an allowed root', async () => {
    const source = await reader().read(join(root, 'image.png'));
    expect(source.mimeType).toBe('image/png');
    expect(source.mediaType).toBe('image');
    expect(source.size).toBe(PNG_BYTES.byteLength);
    expect(source.digest).toBe(sha256Hex(PNG_BYTES));
    expect(source.bytes).toEqual(PNG_BYTES);
  });

  it('allows a symlink that stays inside the root', async () => {
    const source = await reader().read(join(root, 'self-link.png'));
    expect(source.digest).toBe(sha256Hex(PNG_BYTES));
  });

  it('rejects relative traversal out of a root', async () => {
    await expectGatewayError(reader().read(join(root, 'nested', '..', '..', 'etc', 'passwd')), 'INVALID_INPUT');
  });

  it('rejects an absolute path outside every root', async () => {
    await expectGatewayError(reader().read(join(outside, 'secret.png')), 'INVALID_INPUT');
  });

  it('rejects a symlink that escapes the root', async () => {
    await expectGatewayError(reader().read(join(root, 'escape.png')), 'INVALID_INPUT');
  });

  it('rejects a symlinked root that does not resolve', async () => {
    const dangling = join(root, 'dangling-root');
    symlinkSync(join(outside, 'missing'), dangling);
    await expectGatewayError(reader({ allowedPaths: [dangling] }).read(join(root, 'image.png')), 'INVALID_INPUT');
  });

  it('rejects directories, empty files, and oversized files', async () => {
    await expectGatewayError(reader().read(join(root, 'directory.png')), 'INVALID_INPUT');
    await expectGatewayError(reader().read(join(root, 'empty.png')), 'INVALID_INPUT');
    await expectGatewayError(reader({ maxBytes: 8 }).read(join(root, 'image.png')), 'INVALID_INPUT');
  });

  it('rejects content that is not a supported media type', async () => {
    await expectGatewayError(reader().read(join(root, 'notes.txt')), 'INVALID_INPUT');
  });

  it('rejects a missing file without leaking filesystem errors', async () => {
    const error = await expectGatewayError(reader().read(join(root, 'nope.png')), 'INVALID_INPUT');
    expect(error.message).not.toContain('ENOENT');
  });

  it('denies every path when local file access is off', async () => {
    await expectGatewayError(reader({ localFileAccess: false }).read(join(root, 'image.png')), 'INVALID_INPUT');
  });

  it('denies every path when no roots are configured', async () => {
    await expectGatewayError(reader({ allowedPaths: [] }).read(join(root, 'image.png')), 'INVALID_INPUT');
  });
});

describe('identify', () => {
  it('returns digest, size, and type without uploading', async () => {
    const meta = await reader().identify(join(root, 'image.png'));
    expect(meta.digest).toBe(sha256Hex(PNG_BYTES));
    expect(meta.size).toBe(PNG_BYTES.byteLength);
    expect(meta.mimeType).toBe('image/png');
  });

  it('applies the same allowlist rules', async () => {
    await expectGatewayError(reader().identify(join(outside, 'secret.png')), 'INVALID_INPUT');
    await expectGatewayError(reader({ localFileAccess: false }).identify(join(root, 'image.png')), 'INVALID_INPUT');
  });

  it('recomputes the digest when the file changes', async () => {
    const path = join(root, 'changing.png');
    writeFileSync(path, PNG_BYTES);
    const before = await reader().identify(path);
    writeFileSync(path, new Uint8Array([...PNG_BYTES, 0x00]));
    const after = await reader().identify(path);
    expect(after.digest).not.toBe(before.digest);
    expect(after.size).toBe(before.size + 1);
  });
});
