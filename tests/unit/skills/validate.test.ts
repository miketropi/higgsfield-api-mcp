import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { validateSkills } from '@higgsfield-mcp/skills';
import { createRepoFixture, readJson, registryEndpointIds, REPO_ROOT, SKILLS_DIR, type RepoFixture } from './helpers.js';
import { join } from 'node:path';

const fixtures: RepoFixture[] = [];

function fixture(): RepoFixture {
  const created = createRepoFixture();
  fixtures.push(created);
  return created;
}

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup();
});

const endpoints = registryEndpointIds();

describe('validateSkills', () => {
  it('accepts the shipped tree generated from the pinned commit', async () => {
    const result = await validateSkills({ skillsDir: SKILLS_DIR, repoRoot: REPO_ROOT, registryEndpointIds: endpoints });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('fails a declared tool that is not part of the MCP contract', async () => {
    const repo = fixture();
    const skillFile = join(repo.skillsDir, 'higgsfield-generate', 'SKILL.md');
    writeFileSync(skillFile, readFileSync(skillFile, 'utf8').replace('    - higgsfield.jobs.wait\n', '    - higgsfield.jobs.pause\n    - higgsfield.jobs.wait\n'));
    const result = await validateSkills({ skillsDir: repo.skillsDir, repoRoot: repo.root, registryEndpointIds: endpoints });
    expect(result.errors.join('\n')).toMatch(/unknown tool "higgsfield\.jobs\.pause"/);
  });

  it('fails an endpoint that the registry catalog does not contain', async () => {
    const repo = fixture();
    const skillFile = join(repo.skillsDir, 'higgsfield-generate', 'SKILL.md');
    writeFileSync(skillFile, readFileSync(skillFile, 'utf8').replace('bytedance/seedance-2.5/image-to-video', 'bytedance/seedance-9.9/image-to-video'));
    const result = await validateSkills({ skillsDir: repo.skillsDir, repoRoot: repo.root, registryEndpointIds: endpoints });
    expect(result.errors.join('\n')).toMatch(/endpoint "bytedance\/seedance-9.9\/image-to-video" is not in the registry catalog/);
  });

  it('fails a reference that does not resolve inside the generated tree', async () => {
    const repo = fixture();
    const skillFile = join(repo.skillsDir, 'higgsfield-generate', 'SKILL.md');
    writeFileSync(skillFile, readFileSync(skillFile, 'utf8').replace('`references/prompt-engineering.md`', '`references/prompt-strategy.md`'));
    const result = await validateSkills({ skillsDir: repo.skillsDir, repoRoot: repo.root, registryEndpointIds: endpoints });
    expect(result.errors.join('\n')).toMatch(/does not resolve inside the generated tree/);
  });

  it('fails a vendored file whose bytes no longer match the pinned hash', async () => {
    const repo = createRepoFixture({ copySource: true });
    fixtures.push(repo);
    writeFileSync(join(repo.sourceDir, 'higgsfield-soul-id', 'references', 'photo-guide.md'), '# tampered\n');
    const result = await validateSkills({ skillsDir: repo.skillsDir, repoRoot: repo.root, registryEndpointIds: endpoints });
    expect(result.errors.join('\n')).toMatch(/hash [0-9a-f]{16}… does not match the pinned/);
  });

  it('fails a shipped tree that drifted from the staged generation or was hand-edited', async () => {
    const repo = fixture();
    const manifest = readJson<{ adapterVersion: string }>(join(repo.skillsDir, 'manifest.json'));
    writeFileSync(join(repo.skillsDir, 'manifest.json'), `${JSON.stringify({ ...manifest, adapterVersion: '9.9.9' }, null, 2)}\n`);
    const result = await validateSkills({ skillsDir: repo.skillsDir, repoRoot: repo.root, registryEndpointIds: endpoints });
    expect(result.errors.join('\n')).toMatch(/not byte-identical to packages\/skills\/manifest\.json/);
  });

  it('fails a classified skill shipping although it is not compatible or partial', async () => {
    const repo = fixture();
    mkdirSync(join(repo.skillsDir, 'higgsfield-brandkit'), { recursive: true });
    writeFileSync(join(repo.skillsDir, 'higgsfield-brandkit', 'SKILL.md'), '# brandkit\n');
    const result = await validateSkills({ skillsDir: repo.skillsDir, repoRoot: repo.root, registryEndpointIds: endpoints });
    expect(result.errors.join('\n')).toMatch(/"higgsfield-brandkit" is unsupported and must not ship/);
    expect(existsSync(join(repo.skillsDir, 'higgsfield-brandkit', 'SKILL.md'))).toBe(true);
  });
});
