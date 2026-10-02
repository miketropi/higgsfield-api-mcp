import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { SkillsError } from './errors.js';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Every file under `root`, as POSIX-style relative paths, sorted for determinism. */
export function listTree(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) found.push(relative(root, absolute).split(sep).join('/'));
    }
  };
  walk(root);
  return found;
}

export function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of listTree(root)) files.set(path, readFileSync(join(root, path), 'utf8'));
  return files;
}

export function writeTree(root: string, files: Map<string, string>): void {
  rmSync(root, { recursive: true, force: true });
  for (const [path, content] of files) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
}

function timestamp(): string {
  return `${process.pid}-${Date.now().toString(36)}`;
}

/**
 * Replaces `target` with `source` in one step, keeping the previous tree until the new one is
 * in place: a failure while staging leaves the old tree byte-identical (SPEC §25).
 */
export function atomicReplaceDirectory(source: string, target: string): void {
  if (!existsSync(source)) throw new SkillsError(`Cannot replace ${target}: staging directory ${source} does not exist.`);
  const backup = `${target}.previous-${timestamp()}`;
  const hadTarget = existsSync(target);
  if (hadTarget) renameSync(target, backup);
  try {
    renameSync(source, target);
  } catch (error) {
    if (hadTarget) renameSync(backup, target);
    throw new SkillsError(`Cannot install ${target} (${(error as Error).message}); the previous tree was restored.`);
  }
  if (hadTarget) rmSync(backup, { recursive: true, force: true });
}

export function stagingPath(target: string): string {
  return `${target}.staging-${timestamp()}`;
}

export function assertDirectory(path: string, what: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new SkillsError(`${what} is not a directory: ${path}.`);
}

export function copyTree(source: string, target: string): void {
  mkdirSync(dirname(resolve(target)), { recursive: true });
  cpSync(source, target, { recursive: true });
}
