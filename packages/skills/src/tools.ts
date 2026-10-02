/**
 * Frozen MCP tool names published by `packages/mcp/src/schemas.ts` (SPEC §10, §57).
 *
 * This package depends on `@higgsfield-mcp/core` only, so the list is mirrored here
 * instead of imported from the MCP package. `tests/unit/skills/tool-names.test.ts`
 * reads `packages/mcp/src/schemas.ts` and fails when the two lists drift.
 *
 * `role` drives validation: a workflow must discover before it spends, media must be
 * uploaded (or referenced) before it is chained, and every spend call needs approval.
 */
export const TOOL_ROLE: Readonly<Record<string, 'discovery' | 'spend' | 'media' | 'job'>> = {
  'higgsfield.capabilities': 'discovery',
  'higgsfield.models.list': 'discovery',
  'higgsfield.models.get': 'discovery',
  'higgsfield.generate': 'spend',
  'higgsfield.generate_image': 'spend',
  'higgsfield.edit_image': 'spend',
  'higgsfield.generate_video': 'spend',
  'higgsfield.animate_image': 'spend',
  'higgsfield.media.upload': 'media',
  'higgsfield.media.get': 'media',
  'higgsfield.jobs.get': 'job',
  'higgsfield.jobs.wait': 'job',
  'higgsfield.jobs.cancel': 'job',
  'higgsfield.jobs.list': 'job'
};

export type KnownTool = keyof typeof TOOL_ROLE;

export const KNOWN_TOOLS = Object.keys(TOOL_ROLE) as KnownTool[];

/** Type guard: narrows a declared tool name to the frozen set, so validation can index `TOOL_ROLE`. */
export function isKnownTool(name: string): name is KnownTool {
  return Object.hasOwn(TOOL_ROLE, name);
}
