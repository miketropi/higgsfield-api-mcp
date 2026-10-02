import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locates the generated skills tree: an explicit `HF_MCP_SKILLS_DIR` wins, then the
 * directory shipped next to the built CLI (packaged container/tarball), then the
 * `skills/` directory of a source checkout.
 */
export function resolveSkillsDir(configured: string | undefined): string | undefined {
  if (configured !== undefined) return resolve(configured);
  const candidates = [join(here, 'skills'), resolve(here, '..', 'skills'), resolve(process.cwd(), 'skills')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'manifest.json'))) return candidate;
  }
  return undefined;
}
