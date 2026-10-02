import { gunzipSync } from 'node:zlib';
import { SkillsError } from './errors.js';

/** Everything a skill file can request from the network. Injectable so unit tests never touch the wire. */
export interface UpstreamTransport {
  fetchTarball(commit: string): Promise<Uint8Array>;
  fetchJson(url: string): Promise<unknown>;
}

export const CODELOAD_BASE = 'https://codeload.github.com';
export const GITHUB_API_BASE = 'https://api.github.com';

export interface HttpTransportOptions {
  fetchImpl?: typeof fetch | undefined;
  token?: string | undefined;
  repository?: string | undefined;
  codeloadBase?: string | undefined;
  timeoutMs?: number | undefined;
}

export function createHttpTransport(options: HttpTransportOptions = {}): UpstreamTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const codeloadBase = options.codeloadBase ?? CODELOAD_BASE;
  const repository = options.repository ?? 'higgsfield-ai/skills';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'higgsfield-mcp-skills' };
  if (options.token !== undefined && options.token.length > 0) headers['authorization'] = `Bearer ${options.token}`;

  const get = async (url: string): Promise<Response> => {
    try {
      return await doFetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new SkillsError(`Cannot reach ${url}: ${(error as Error).message}.`);
    }
  };

  return {
    async fetchTarball(commit) {
      const url = `${codeloadBase}/${repository}/tar.gz/${commit}`;
      const response = await get(url);
      if (!response.ok) throw new SkillsError(`${url} returned HTTP ${response.status}.`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async fetchJson(url) {
      const response = await get(url);
      if (!response.ok) throw new SkillsError(`${url} returned HTTP ${response.status}.`);
      return (await response.json()) as unknown;
    }
  };
}

const BLOCK = 512;
const UTF8 = new TextDecoder('utf-8', { fatal: false });

function octal(bytes: Uint8Array, offset: number, length: number): number {
  const text = UTF8.decode(bytes.subarray(offset, offset + length)).replace(/\0.*$/, '').trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new SkillsError('Upstream archive has an unreadable tar header.');
  return value;
}

function field(bytes: Uint8Array, offset: number, length: number): string {
  return UTF8.decode(bytes.subarray(offset, offset + length)).replace(/\0.*$/, '');
}

/**
 * Minimal ustar reader for the GitHub codeload archive. Handles regular files and
 * directories; every other entry type is ignored rather than guessed at. Returns
 * paths relative to the archive's single root directory.
 *
 * The archive is untrusted input: absolute paths and `..` segments are rejected.
 */
export function extractTarGz(archive: Uint8Array): Map<string, Uint8Array> {
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(gunzipSync(archive));
  } catch (error) {
    throw new SkillsError(`Upstream archive is not valid gzip (${(error as Error).message}).`);
  }
  const files = new Map<string, Uint8Array>();
  for (let offset = 0; offset + BLOCK <= raw.byteLength; offset += BLOCK) {
    const header = raw.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const type = field(header, 156, 1);
    const size = octal(header, 124, 12);
    const full = prefix.length === 0 ? name : `${prefix}/${name}`;
    const dataStart = offset + BLOCK;
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK - BLOCK;
    if (type !== '0' && type !== '') continue;
    const segments = full.split('/').filter((segment) => segment.length > 0);
    if (segments.length < 2 || full.startsWith('/') || segments.includes('..')) {
      throw new SkillsError(`Upstream archive entry "${full}" is not a safe relative path.`);
    }
    files.set(segments.slice(1).join('/'), raw.subarray(dataStart, dataStart + size));
  }
  if (files.size === 0) throw new SkillsError('Upstream archive contained no files.');
  return files;
}
