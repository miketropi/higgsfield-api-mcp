import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string): string => fileURLToPath(new URL(`packages/${name}/src`, import.meta.url));
const app = (name: string): string => fileURLToPath(new URL(`apps/${name}/src`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@higgsfield-mcp/core': `${pkg('core')}/index.ts`,
      '@higgsfield-mcp/provider-higgsfield': `${pkg('provider-higgsfield')}/index.ts`,
      '@higgsfield-mcp/mcp': `${pkg('mcp')}/index.ts`,
      '@higgsfield-mcp/config': `${pkg('config')}/index.ts`,
      '@higgsfield-mcp/observability': `${pkg('observability')}/index.ts`,
      '@higgsfield-mcp/skills': `${pkg('skills')}/index.ts`,
      '@higgsfield-mcp/server': app('server')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default'],
    pool: 'forks'
  }
});
