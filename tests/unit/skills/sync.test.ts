import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { syncSkills, type SyncOptions } from '@higgsfield-mcp/skills';
import { createRepoFixture, fakeTransport, makeTarGz, readJson, readTreeDigest, REPO_ROOT, SKILLS_DIR, type RepoFixture } from './helpers.js';

const fixtures: RepoFixture[] = [];
const logs: string[] = [];

function fixture(): RepoFixture {
  const created = createRepoFixture({ copySource: true });
  fixtures.push(created);
  return created;
}

function options(repo: RepoFixture, overrides: Partial<SyncOptions> = {}): SyncOptions {
  return {
    repoRoot: repo.root,
    upstream: '',
    sourceDir: repo.sourceDir,
    patchesDir: repo.patchesDir,
    generatedDir: repo.generatedDir,
    log: (line) => logs.push(line),
    offline: true,
    ...overrides
  };
}

function archiveFromVendoredSource(root: string, overrides: Record<string, string> = {}): Uint8Array {
  const manifest = readJson<{ skills: { name: string }[] }>(join(REPO_ROOT, 'packages', 'skills', 'manifest.json'));
  const entries: Record<string, string | Uint8Array> = { VERSION: '0.13.0\n' };
  for (const skill of manifest.skills) {
    for (const relativePath of listFiles(join(REPO_ROOT, 'packages', 'skills', 'source', skill.name))) {
      entries[`${skill.name}/${relativePath}`] = readFileSync(join(REPO_ROOT, 'packages', 'skills', 'source', skill.name, relativePath));
    }
  }
  return makeTarGz({ ...entries, ...overrides }, root);
}

function listFiles(root: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    const absolute = join(root, entry);
    if (statSync(absolute).isDirectory()) found.push(...listFiles(absolute, `${prefix}${entry}/`));
    else found.push(`${prefix}${entry}`);
  }
  return found;
}

afterEach(() => {
  logs.length = 0;
  for (const created of fixtures.splice(0)) created.cleanup();
});

describe('syncSkills', () => {
  it('reproduces the shipped tree byte-for-byte from the vendored source', async () => {
    const repo = fixture();
    const result = await syncSkills(options(repo));
    expect(result.commit).toBe('f83af0bc1d937c8119099a11f8ebbf5e6fb99819');
    expect(result.version).toBe('0.13.0');
    expect(result.generated).toEqual(['higgsfield-generate', 'higgsfield-soul-id']);
    expect(readTreeDigest(repo.skillsDir)).toBe(readTreeDigest(SKILLS_DIR));
    expect(readTreeDigest(repo.generatedDir)).toBe(readTreeDigest(SKILLS_DIR));
    expect(logs.join('\n')).toMatch(/installed 2 skill\(s\)/);
  });

  it('is deterministic: a second run produces the same bytes', async () => {
    const repo = fixture();
    await syncSkills(options(repo));
    const first = readTreeDigest(repo.skillsDir);
    await syncSkills(options(repo));
    expect(readTreeDigest(repo.skillsDir)).toBe(first);
  });

  it('produces the same tree when the pinned commit is fetched over the transport seam', async () => {
    const repo = fixture();
    const transport = fakeTransport({ fetchTarball: () => Promise.resolve(archiveFromVendoredSource('skills-f83af0bc')) });
    await syncSkills(options(repo, { offline: false, transport }));
    expect(readTreeDigest(repo.skillsDir)).toBe(readTreeDigest(SKILLS_DIR));
  });

  it('aborts on a hash mismatch and leaves the previous tree untouched', async () => {
    const repo = fixture();
    const before = readTreeDigest(repo.skillsDir);
    appendFileSync(join(repo.sourceDir, 'higgsfield-generate', 'SKILL.md'), '\ntampered\n');
    await expect(syncSkills(options(repo))).rejects.toThrow(/but the manifest pins/);
    expect(readTreeDigest(repo.skillsDir)).toBe(before);
  });

  it('aborts on a changed patch hunk and leaves the previous tree untouched', async () => {
    const repo = fixture();
    const before = readTreeDigest(repo.skillsDir);
    const rules = readJson<{ documents: { rules: { id: string; expected: number }[] }[] }>(join(repo.patchesDir, 'rules.json'));
    const rule = rules.documents[0]?.rules[0] as { id: string; expected: number };
    rule.expected = 999;
    writeFileSync(join(repo.patchesDir, 'rules.json'), `${JSON.stringify(rules, null, 2)}\n`);
    await expect(syncSkills(options(repo))).rejects.toThrow(new RegExp(`patch rule "${rule.id}" matched`));
    expect(readTreeDigest(repo.skillsDir)).toBe(before);
  });

  it('refuses a moving ref', async () => {
    const repo = fixture();
    await expect(syncSkills(options(repo, { upstream: 'main' }))).rejects.toThrow(/immutable commit SHA/);
  });

  it('refuses to stage another commit offline', async () => {
    const repo = fixture();
    await expect(syncSkills(options(repo, { upstream: '0'.repeat(40) }))).rejects.toThrow(/only reproduce the pinned commit/);
  });

  it('refuses an upstream release that the manifest does not pin', async () => {
    const repo = fixture();
    const transport = fakeTransport({ fetchTarball: () => Promise.resolve(archiveFromVendoredSource('skills-next', { VERSION: '0.14.0\n' })) });
    await expect(syncSkills(options(repo, { offline: false, transport }))).rejects.toThrow(/does not match the pinned 0\.13\.0/);
  });

  it('refuses upstream skill files that the manifest does not classify', async () => {
    const repo = fixture();
    const transport = fakeTransport({
      fetchTarball: () => Promise.resolve(archiveFromVendoredSource('skills-next', { 'higgsfield-newcomer/SKILL.md': '# new\n' }))
    });
    await expect(syncSkills(options(repo, { offline: false, transport }))).rejects.toThrow(/does not classify/);
  });

  it('refuses a vendored file that the patch set does not classify', async () => {
    const repo = fixture();
    writeFileSync(join(repo.sourceDir, 'higgsfield-soul-id', 'references', 'extra.md'), '# extra\n');
    await expect(syncSkills(options(repo))).rejects.toThrow(/has no disposition/);
  });
});
