import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SkillsError } from './errors.js';

export interface SkillManifestEntry {
  name: string;
  status: 'compatible' | 'partial' | 'unsupported' | 'excluded';
  workflows: string[];
  requiredTools: string[];
  reason: string;
  sourceHashes: Record<string, string>;
}

export interface SkillManifest {
  upstream: { repository: string; commit: string; version: string };
  adapterVersion: string;
  skills: SkillManifestEntry[];
}

/**
 * `sourceHashes` values are lowercase hex SHA-256 of the exact upstream file bytes.
 * The research reference publishes the same digests base64-encoded; hex is used here
 * because `node:crypto` produces hex without a decode step.
 */
const hexSha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex SHA-256');

const manifestSchema = z
  .object({
    upstream: z
      .object({
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'expected owner/repository'),
        commit: z.string().regex(/^[0-9a-f]{40}$/, 'expected an immutable 40-character commit SHA'),
        version: z.string().min(1)
      })
      .strict(),
    adapterVersion: z.string().regex(/^\d+\.\d+\.\d+$/, 'expected a semver version'),
    skills: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'expected a kebab-case skill name'),
            status: z.enum(['compatible', 'partial', 'unsupported', 'excluded']),
            workflows: z.array(z.string().min(1)),
            requiredTools: z.array(z.string().min(1)),
            reason: z.string().min(1),
            sourceHashes: z.record(z.string().min(1), hexSha256)
          })
          .strict()
      )
      .min(1)
  })
  .strict();

/** Status/declaration coherence: a shipped skill names its workflows and tools, an unavailable one names neither. */
function assertCoherent(manifest: SkillManifest, source: string): void {
  const seen = new Set<string>();
  for (const skill of manifest.skills) {
    if (seen.has(skill.name)) throw new SkillsError(`${source}: duplicate skill entry "${skill.name}".`);
    seen.add(skill.name);
    const ships = skill.status === 'compatible' || skill.status === 'partial';
    if (ships && (skill.workflows.length === 0 || skill.requiredTools.length === 0)) {
      throw new SkillsError(
        `${source}: "${skill.name}" is ${skill.status} but declares no ${skill.workflows.length === 0 ? 'workflows' : 'tools'}.`
      );
    }
    if (!ships && (skill.workflows.length > 0 || skill.requiredTools.length > 0)) {
      throw new SkillsError(`${source}: "${skill.name}" is ${skill.status} and must not declare workflows or tools.`);
    }
  }
}

export function loadManifest(skillsDir: string): SkillManifest {
  const path = join(skillsDir, 'manifest.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SkillsError(`${path}: cannot read the skills manifest (${(error as Error).message}).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SkillsError(`${path}: manifest is not valid JSON (${(error as Error).message}).`);
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new SkillsError(
      `${path}: manifest is invalid at ${issue === undefined ? '(root)' : issue.path.join('.')} — ${
        issue === undefined ? 'parse failed' : issue.message
      }.`
    );
  }
  const manifest = result.data as SkillManifest;
  assertCoherent(manifest, path);
  return manifest;
}
