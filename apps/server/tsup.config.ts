import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/**
 * Copies the data assets the runtime resolves relative to `dist/` (SQL migrations and
 * the generated skills tree) so `npm install higgsfield-mcp` produces a working
 * `migrate` and a populated `skills list`, not just a container image.
 */
function copyRuntimeAssets(): void {
  const assets: [string, string][] = [
    [join(repoRoot, 'packages', 'core', 'src', 'jobs', 'postgres', 'migrations'), join(here, 'dist', 'migrations')],
    [join(repoRoot, 'skills'), join(here, 'dist', 'skills')]
  ];
  for (const [from, to] of assets) {
    if (!existsSync(from)) continue;
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
}

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
  // Internal workspace code is bundled so a packed install never resolves workspace:*.
  noExternal: [/^@higgsfield-mcp\//],
  onSuccess: async () => {
    copyRuntimeAssets();
  }
});
