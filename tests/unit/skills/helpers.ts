import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { UpstreamTransport } from '@higgsfield-mcp/skills';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SKILLS_DIR = join(REPO_ROOT, 'skills');

/** Content hash of every file under `root`, used to prove a failed sync changed nothing. */
export function readTreeDigest(root: string): string {
  const hash = createHash('sha256');
  for (const relativePath of listTree(root)) hash.update(`${relativePath}\n${readFileSync(join(root, relativePath), 'utf8')}\n`);
  return hash.digest('hex');
}

/** Every file under `root` as POSIX-style relative paths, sorted. */
export function listTree(root: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    const absolute = join(root, entry);
    if (statSync(absolute).isDirectory()) found.push(...listTree(absolute, `${prefix}${entry}/`));
    else found.push(`${prefix}${entry}`);
  }
  return found;
}

export interface RepoFixture {
  root: string;
  skillsDir: string;
  sourceDir: string;
  patchesDir: string;
  generatedDir: string;
  cleanup: () => void;
}

/**
 * A throwaway repository root holding the real manifest, patch set and shipped tree.
 * `source/` is symlinked by default so tests stay fast; `copySource` opts into a real copy
 * when a test needs to mutate a vendored file.
 */
export function createRepoFixture(options: { copySource?: boolean } = {}): RepoFixture {
  const root = mkdtempSync(join(tmpdir(), 'hf-skills-'));
  const packageDir = join(root, 'packages', 'skills');
  mkdirSync(packageDir, { recursive: true });
  const realPackage = join(REPO_ROOT, 'packages', 'skills');
  cpSync(join(realPackage, 'manifest.json'), join(packageDir, 'manifest.json'));
  cpSync(join(realPackage, 'patches'), join(packageDir, 'patches'), { recursive: true });
  if (options.copySource === true) cpSync(join(realPackage, 'source'), join(packageDir, 'source'), { recursive: true });
  else symlinkSync(join(realPackage, 'source'), join(packageDir, 'source'), 'dir');
  // Sync validates the generated tree against the provider catalog before swapping.
  symlinkSync(join(REPO_ROOT, 'packages', 'provider-higgsfield'), join(root, 'packages', 'provider-higgsfield'), 'dir');
  cpSync(SKILLS_DIR, join(root, 'skills'), { recursive: true });
  return {
    root,
    skillsDir: join(root, 'skills'),
    sourceDir: join(packageDir, 'source'),
    patchesDir: join(packageDir, 'patches'),
    generatedDir: join(packageDir, 'generated'),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

const BLOCK = 512;

function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const write = (offset: number, length: number, value: string): void => {
    header.set(new TextEncoder().encode(value).subarray(0, length), offset);
  };
  const octal = (value: number, length: number): string => `${value.toString(8).padStart(length - 1, '0')}\0`;
  write(0, 100, name);
  write(100, 8, octal(0o644, 8));
  write(108, 8, octal(0, 8));
  write(116, 8, octal(0, 8));
  write(124, 12, octal(size, 12));
  write(136, 12, octal(0, 12));
  write(148, 8, '        ');
  write(156, 1, '0');
  write(257, 6, 'ustar\0');
  write(263, 2, '00');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  write(148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

/** Minimal ustar writer, used to drive the online sync path without touching the network. */
export function makeTarGz(entries: Record<string, string | Uint8Array>, root = 'skills-f83af0bc'): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [path, content] of Object.entries(entries)) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    chunks.push(tarHeader(`${root}/${path}`, bytes.byteLength), bytes, new Uint8Array((BLOCK - (bytes.byteLength % BLOCK)) % BLOCK));
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  const tar = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Uint8Array(gzipSync(tar));
}

export function fakeTransport(overrides: Partial<UpstreamTransport> = {}): UpstreamTransport {
  return {
    fetchTarball: () => Promise.reject(new Error('test transport has no tarball')),
    fetchJson: () => Promise.reject(new Error('test transport has no JSON')),
    ...overrides
  };
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

/** The endpoint ids the validator is given at the gate (see apps/server/src/cli.ts). */
export function registryEndpointIds(): string[] {
  const catalog = readJson<{ models: { endpoint: string }[] }>(join(REPO_ROOT, 'packages', 'provider-higgsfield', 'src', 'models', 'registry.json'));
  return catalog.models.map((model) => model.endpoint);
}
