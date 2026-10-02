import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncSkills, validateSkills, type SyncOptions } from '@higgsfield-mcp/skills';
import { createRepoFixture, readJson, readTreeDigest, registryEndpointIds, type RepoFixture } from '../unit/skills/helpers.js';

/**
 * Injected failures: the two ways a generated skill tree can go wrong — a reference the MCP
 * contract cannot satisfy, and a patch hunk that no longer matches the pinned upstream file.
 * Both must fail loudly, and neither may leave `skills/**` modified.
 */
const fixtures: RepoFixture[] = [];

function fixture(): RepoFixture {
  const created = createRepoFixture({ copySource: true });
  fixtures.push(created);
  return created;
}

function options(repo: RepoFixture): SyncOptions {
  return {
    repoRoot: repo.root,
    upstream: '',
    sourceDir: repo.sourceDir,
    patchesDir: repo.patchesDir,
    generatedDir: repo.generatedDir,
    log: () => undefined,
    offline: true
  };
}

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup();
});

describe('injected failure: a broken tool reference', () => {
  it('fails validation without writing anything', async () => {
    const repo = fixture();
    const skillFile = join(repo.skillsDir, 'higgsfield-generate', 'SKILL.md');
    writeFileSync(skillFile, readFileSync(skillFile, 'utf8').replace('"tool": "higgsfield.media.upload"', '"tool": "higgsfield.media.put"'));
    const mutated = readTreeDigest(repo.skillsDir);

    const result = await validateSkills({ skillsDir: repo.skillsDir, repoRoot: repo.root, registryEndpointIds: registryEndpointIds() });
    expect(result.errors.join('\n')).toMatch(/higgsfield\.media\.put/);
    expect(readTreeDigest(repo.skillsDir)).toBe(mutated);
  });

  it('fails when the approval checkpoint no longer precedes the spending call', async () => {
    const repo = fixture();
    const skillFile = join(repo.skillsDir, 'higgsfield-generate', 'SKILL.md');
    writeFileSync(skillFile, readFileSync(skillFile, 'utf8').replaceAll('"gate": "approval", ', ''));
    const result = await validateSkills({ skillsDir: repo.skillsDir, repoRoot: repo.root, registryEndpointIds: registryEndpointIds() });
    expect(result.errors.join('\n')).toMatch(/approval checkpoint must precede/);
  });

  it('fails when a CLI invocation is smuggled into the generated tree', async () => {
    const repo = fixture();
    const skillFile = join(repo.skillsDir, 'higgsfield-generate', 'SKILL.md');
    writeFileSync(skillFile, `${readFileSync(skillFile, 'utf8')}\n\nRun \`higgsfield generate create gpt_image_2_5 --wait\` to submit.\n`);
    const result = await validateSkills({ skillsDir: repo.skillsDir, repoRoot: repo.root, registryEndpointIds: registryEndpointIds() });
    expect(result.errors.join('\n')).toMatch(/Higgsfield CLI invocation/);
  });
});

describe('injected failure: a changed patch hunk', () => {
  it('fails sync while the previous skills/** tree stays byte-identical', async () => {
    const repo = fixture();
    const before = readTreeDigest(repo.skillsDir);

    const rules = readJson<{ documents: { skill: string; source: string; rules: { id: string; from?: string }[] }[] }>(join(repo.patchesDir, 'rules.json'));
    const generate = rules.documents.find((document) => document.skill === 'higgsfield-generate' && document.source === 'SKILL.md');
    const rule = generate?.rules.find((candidate) => candidate.id === 'workflow-deliver') as { id: string; from?: string };
    rule.from = '5. **Deliver.** This upstream sentence no longer exists.';
    writeFileSync(join(repo.patchesDir, 'rules.json'), `${JSON.stringify(rules, null, 2)}\n`);

    await expect(syncSkills(options(repo))).rejects.toThrow(/patch rule "workflow-deliver" matched 0 time\(s\), expected 1/);
    expect(readTreeDigest(repo.skillsDir)).toBe(before);
  });

  it('fails sync when a fragment the patch hunk needs is gone', async () => {
    const repo = fixture();
    const before = readTreeDigest(repo.skillsDir);
    const rules = readJson<{ documents: { rules: { fragment?: string }[] }[] }>(join(repo.patchesDir, 'rules.json'));
    const fragment = rules.documents[0]?.rules.find((rule) => rule.fragment !== undefined)?.fragment as string;

    rmSync(join(repo.patchesDir, 'fragments', fragment));
    await expect(syncSkills(options(repo))).rejects.toThrow(/cannot read the fragment/);
    expect(readTreeDigest(repo.skillsDir)).toBe(before);
  });
});
