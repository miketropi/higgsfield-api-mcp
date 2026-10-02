import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadManifest, SkillsError } from '@higgsfield-mcp/skills';
import { readJson, REPO_ROOT, writeJson } from './helpers.js';

const dirs: string[] = [];

function scratchManifest(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'hf-manifest-'));
  dirs.push(dir);
  writeJson(join(dir, 'manifest.json'), manifest);
  return dir;
}

function baseManifest(): Record<string, unknown> {
  return readJson<Record<string, unknown>>(join(REPO_ROOT, 'packages', 'skills', 'manifest.json'));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadManifest', () => {
  it('reads the pinned manifest and its classification', () => {
    const manifest = loadManifest(join(REPO_ROOT, 'packages', 'skills'));
    expect(manifest.upstream).toEqual({
      repository: 'higgsfield-ai/skills',
      commit: 'f83af0bc1d937c8119099a11f8ebbf5e6fb99819',
      version: '0.13.0'
    });
    expect(manifest.adapterVersion).toBe('0.1.0');
    expect(manifest.skills).toHaveLength(8);
    const byName = new Map(manifest.skills.map((skill) => [skill.name, skill]));
    expect(byName.get('higgsfield-generate')?.status).toBe('compatible');
    expect(byName.get('higgsfield-soul-id')?.status).toBe('partial');
    expect(byName.get('higgsfield-websites')?.status).toBe('excluded');
    for (const skill of manifest.skills) {
      const ships = skill.status === 'compatible' || skill.status === 'partial';
      expect(skill.workflows.length > 0).toBe(ships);
      expect(skill.requiredTools.length > 0).toBe(ships);
      expect(Object.keys(skill.sourceHashes).length).toBeGreaterThan(0);
      for (const hash of Object.values(skill.sourceHashes)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(skill.reason.length).toBeGreaterThan(40);
    }
  });

  it('refuses a moving ref instead of a commit', () => {
    const manifest = baseManifest();
    (manifest['upstream'] as Record<string, unknown>)['commit'] = 'main';
    expect(() => loadManifest(scratchManifest(manifest))).toThrow(/upstream\.commit/);
  });

  it('refuses duplicate skill entries', () => {
    const manifest = baseManifest();
    const skills = manifest['skills'] as unknown[];
    skills.push(skills[0]);
    expect(() => loadManifest(scratchManifest(manifest))).toThrow(/duplicate skill entry/);
  });

  it('refuses a compatible entry that declares no workflows', () => {
    const manifest = baseManifest();
    const skill = (manifest['skills'] as Record<string, unknown>[]).find((entry) => entry['name'] === 'higgsfield-generate');
    (skill as Record<string, unknown>)['workflows'] = [];
    expect(() => loadManifest(scratchManifest(manifest))).toThrow(/declares no workflows/);
  });

  it('refuses an unsupported entry that claims tools', () => {
    const manifest = baseManifest();
    const skill = (manifest['skills'] as Record<string, unknown>[]).find((entry) => entry['name'] === 'higgsfield-brandkit');
    (skill as Record<string, unknown>)['requiredTools'] = ['higgsfield.generate'];
    expect(() => loadManifest(scratchManifest(manifest))).toThrow(/must not declare workflows or tools/);
  });

  it('reports an unreadable or malformed manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-manifest-'));
    dirs.push(dir);
    expect(() => loadManifest(dir)).toThrow(SkillsError);
    writeFileSync(join(dir, 'manifest.json'), '{ not json', 'utf8');
    expect(() => loadManifest(dir)).toThrow(/not valid JSON/);
  });
});
