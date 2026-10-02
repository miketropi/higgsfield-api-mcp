import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_TOOLS, TOOL_ROLE } from '@higgsfield-mcp/skills';
import { REPO_ROOT } from './helpers.js';

/**
 * The adapter mirrors the MCP tool list instead of importing it (this package depends on
 * `@higgsfield-mcp/core` only). This test is the drift guard: a tool renamed in the MCP
 * contract fails here before a generated skill can reference a tool that no longer exists.
 */
describe('mirrored MCP tool names', () => {
  it('matches packages/mcp/src/schemas.ts exactly', () => {
    const source = readFileSync(join(REPO_ROOT, 'packages', 'mcp', 'src', 'schemas.ts'), 'utf8');
    const block = /export const TOOL_NAMES = \[([\s\S]*?)\] as const;/.exec(source);
    expect(block).not.toBeNull();
    const published = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] as string).sort();
    expect([...KNOWN_TOOLS].sort()).toEqual(published);
  });

  it('classifies every tool as discovery, spend, media or job', () => {
    for (const tool of KNOWN_TOOLS) {
      expect(['discovery', 'spend', 'media', 'job']).toContain(TOOL_ROLE[tool]);
    }
  });
});
