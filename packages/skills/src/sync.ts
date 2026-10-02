import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SkillsError } from './errors.js';
import { loadManifest, type SkillManifest } from './manifest.js';
import { buildSkillFiles, loadFragments, loadRuleSet, type PatchRuleSet } from './patch.js';
import { createHttpTransport, extractTarGz, type UpstreamTransport } from './transport.js';
import { atomicReplaceDirectory, copyTree, listTree, sha256Hex, stagingPath, writeTree } from './tree.js';
import { validateSkills } from './validate.js';

export interface SyncOptions {
  repoRoot: string;
  /** Explicit immutable commit to stage; an empty string means the pinned commit. */
  upstream: string;
  sourceDir: string;
  patchesDir: string;
  generatedDir: string;
  log: (line: string) => void;
  /** Injectable network seam. Defaults to the codeload/GitHub HTTP transport. */
  transport?: UpstreamTransport | undefined;
  /** Use the vendored `source/` tree and never touch the network. Also `HF_SKILLS_OFFLINE=1`. */
  offline?: boolean | undefined;
}

export interface SyncResult {
  commit: string;
  version: string;
  generated: string[];
}

const IMMUTABLE_COMMIT = /^[0-9a-f]{40}$/;

function offlineRequested(option: boolean | undefined): boolean {
  if (option !== undefined) return option;
  return process.env['HF_SKILLS_OFFLINE'] === '1' || process.env['HIGGSFIELD_SKILLS_OFFLINE'] === '1';
}

/**
 * Verifies every pinned file of every classified skill against `manifest.sourceHashes`.
 * The fetched archive and the vendored tree go through the same check, so an offline sync
 * proves exactly as much as an online one.
 */
function verifySources(manifest: SkillManifest, read: (path: string) => Uint8Array | undefined, origin: string): void {
  for (const skill of manifest.skills) {
    const pinned = Object.keys(skill.sourceHashes);
    if (pinned.length === 0) throw new SkillsError(`${skill.name}: the manifest pins no source hashes.`);
    for (const relativePath of pinned) {
      const bytes = read(`${skill.name}/${relativePath}`);
      if (bytes === undefined) throw new SkillsError(`${origin}: ${skill.name}/${relativePath} is pinned but missing.`);
      const actual = sha256Hex(bytes);
      const expected = skill.sourceHashes[relativePath] as string;
      if (actual !== expected) {
        throw new SkillsError(
          `${origin}: ${skill.name}/${relativePath} is ${actual.slice(0, 16)}… but the manifest pins ${expected.slice(0, 16)}…. ` +
            'Upstream changed — review the diff, update the manifest and the patches, then sync.'
        );
      }
    }
  }
}

/** Every vendored file of a shipped skill must have exactly one disposition in the patch set. */
function verifyCompleteness(manifest: SkillManifest, ruleSet: PatchRuleSet, vendored: Map<string, string[]>): void {
  for (const skill of manifest.skills) {
    if (skill.status !== 'compatible' && skill.status !== 'partial') continue;
    const dispositions = new Set<string>();
    for (const document of ruleSet.documents) if (document.skill === skill.name) dispositions.add(document.source);
    for (const item of ruleSet.copy) if (item.skill === skill.name) dispositions.add(item.source);
    for (const item of ruleSet.skip) if (item.skill === skill.name) dispositions.add(item.source);
    for (const relativePath of vendored.get(skill.name) ?? []) {
      if (!dispositions.has(relativePath)) {
        throw new SkillsError(
          `patches/rules.json: ${skill.name}/${relativePath} has no disposition (document, copy or skip). Every shipped file must be classified.`
        );
      }
    }
  }
}

/** Endpoint ids the generated tree may reference. Read from the provider catalog, never guessed. */
function endpointIdsFromCatalog(repoRoot: string): string[] {
  const catalog = join(repoRoot, 'packages', 'provider-higgsfield', 'src', 'models', 'registry.json');
  if (!existsSync(catalog)) {
    throw new SkillsError(`Cannot validate endpoint ids: the provider catalog is missing at ${catalog}.`);
  }
  const parsed: unknown = JSON.parse(readFileSync(catalog, 'utf8'));
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) throw new SkillsError(`${catalog}: no models array.`);
  return models
    .map((model: unknown) => (model as { endpoint?: unknown }).endpoint)
    .filter((endpoint): endpoint is string => typeof endpoint === 'string');
}

export async function syncSkills(options: SyncOptions): Promise<SyncResult> {
  const skillsRoot = join(options.repoRoot, 'packages', 'skills');
  const manifest = loadManifest(skillsRoot);
  const ruleSet = loadRuleSet(options.patchesDir);
  if (ruleSet.upstreamCommit !== manifest.upstream.commit) {
    throw new SkillsError(
      `patches/rules.json pins ${ruleSet.upstreamCommit} but the manifest pins ${manifest.upstream.commit}; the patch set belongs to another commit.`
    );
  }
  const requested = options.upstream.trim();
  if (requested !== '' && !IMMUTABLE_COMMIT.test(requested)) {
    throw new SkillsError(`--upstream must be a full immutable commit SHA (got "${requested}"); refusing to follow a moving ref.`);
  }
  const commit = requested === '' ? manifest.upstream.commit : requested;

  if (offlineRequested(options.offline)) {
    if (requested !== '' && requested !== manifest.upstream.commit) {
      throw new SkillsError('Offline sync can only reproduce the pinned commit; run online to stage a different commit.');
    }
    options.log(`skills: offline — verifying the vendored source against ${manifest.upstream.repository}@${commit}`);
    const vendored = new Map<string, string[]>();
    const bytes = new Map<string, Uint8Array>();
    for (const skill of manifest.skills) {
      const paths = listTree(join(options.sourceDir, skill.name));
      vendored.set(skill.name, paths);
      for (const relativePath of paths) {
        bytes.set(`${skill.name}/${relativePath}`, readFileSync(join(options.sourceDir, skill.name, relativePath)));
      }
    }
    verifySources(manifest, (path) => bytes.get(path), 'source/ (offline)');
    verifyCompleteness(manifest, ruleSet, vendored);
  } else {
    options.log(`skills: fetching ${manifest.upstream.repository}@${commit}`);
    const transport =
      options.transport ??
      createHttpTransport({ token: process.env['GITHUB_TOKEN'] ?? undefined, repository: manifest.upstream.repository });
    const archive = extractTarGz(await transport.fetchTarball(commit));
    const version = archive.get('VERSION');
    if (version === undefined) throw new SkillsError('Upstream archive has no VERSION file.');
    const declared = new TextDecoder().decode(version).trim();
    if (declared !== manifest.upstream.version) {
      throw new SkillsError(
        `Upstream version ${declared} does not match the pinned ${manifest.upstream.version}. ` +
          'A new release needs a compatibility PR: review the diff, update the manifest and the patches, then sync.'
      );
    }
    verifySources(manifest, (path) => archive.get(path), `codeload ${commit}`);
    const vendored = new Map<string, string[]>();
    for (const skill of manifest.skills) {
      vendored.set(
        skill.name,
        [...archive.keys()].filter((path) => path.startsWith(`${skill.name}/`)).map((path) => path.slice(skill.name.length + 1))
      );
    }
    verifyCompleteness(manifest, ruleSet, vendored);
    const unexpected = [...archive.keys()].filter(
      (path) => path.startsWith('higgsfield-') && !manifest.skills.some((skill) => path.startsWith(`${skill.name}/`))
    );
    if (unexpected.length > 0) {
      throw new SkillsError(`Upstream ${commit} adds skill files the manifest does not classify: ${unexpected.slice(0, 5).join(', ')}.`);
    }
    for (const [path, content] of [...archive.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
      if (!manifest.skills.some((skill) => path.startsWith(`${skill.name}/`))) continue;
      const target = join(options.sourceDir, path);
      const existing = existsSync(target) ? readFileSync(target) : undefined;
      if (existing !== undefined && sha256Hex(existing) === sha256Hex(content)) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      options.log(`  refreshed source/${path}`);
    }
    options.log('skills: verified every pinned hash against the manifest');
  }

  const manifestBytes = readFileSync(join(skillsRoot, 'manifest.json'), 'utf8');
  const fragments = loadFragments(options.patchesDir, ruleSet);
  const files = new Map<string, string>([['manifest.json', manifestBytes]]);
  const generated: string[] = [];
  options.log('skills: applying the patch set');
  for (const entry of manifest.skills) {
    if (entry.status !== 'compatible' && entry.status !== 'partial') continue;
    const built = buildSkillFiles(entry, manifest, ruleSet, fragments, (skill, source) => {
      const path = join(options.sourceDir, skill, source);
      if (!existsSync(path)) throw new SkillsError(`source/${skill}/${source} is missing: cannot apply the patch set.`);
      return readFileSync(path, 'utf8');
    });
    for (const [path, content] of built.files) files.set(path, content);
    for (const skipped of built.skipped) options.log(`  skip ${entry.name}/${skipped.path} — ${skipped.reason}`);
    options.log(`  ${entry.name}: ${built.files.size} file(s) [${entry.status}]`);
    generated.push(entry.name);
  }

  const staging = stagingPath(options.generatedDir);
  writeTree(staging, files);
  try {
    const validation = await validateSkills({
      skillsDir: staging,
      repoRoot: options.repoRoot,
      registryEndpointIds: endpointIdsFromCatalog(options.repoRoot)
    });
    if (validation.errors.length > 0) {
      throw new SkillsError(`The generated tree failed validation:\n  ${validation.errors.join('\n  ')}`);
    }
    for (const warning of validation.warnings) options.log(`  warn ${warning}`);

    atomicReplaceDirectory(staging, options.generatedDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const shippedStaging = stagingPath(join(options.repoRoot, 'skills'));
  try {
    copyTree(options.generatedDir, shippedStaging);
    atomicReplaceDirectory(shippedStaging, join(options.repoRoot, 'skills'));
  } catch (error) {
    rmSync(shippedStaging, { recursive: true, force: true });
    throw error;
  }
  options.log(`skills: installed ${generated.length} skill(s) at skills/ (upstream ${manifest.upstream.version}@${commit})`);

  return { commit, version: manifest.upstream.version, generated };
}
