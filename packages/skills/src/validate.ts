import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { isSemanticRoute } from '@higgsfield-mcp/core';
import { SkillsError } from './errors.js';
import { loadManifest, type SkillManifest, type SkillManifestEntry } from './manifest.js';
import { loadRuleSet, type PatchRuleSet } from './patch.js';
import { evaluateSkillDocument } from './trace.js';
import { isKnownTool, KNOWN_TOOLS } from './tools.js';
import { listTree, readTree, sha256Hex } from './tree.js';

export interface ValidateOptions {
  skillsDir: string;
  repoRoot: string;
  registryEndpointIds: string[];
}

export interface ValidateResult {
  errors: string[];
  warnings: string[];
}

/** Routing keys every generated skill of that name must declare as unavailable. */
const ROUTING_REQUIREMENTS: Readonly<Record<string, string[]>> = {
  'higgsfield-generate': [
    'product-photoshoot',
    'marketplace-cards',
    'brandkit',
    'video-explainer',
    'youtube-thumbnail',
    'websites',
    'marketing-studio',
    'virality-predictor',
    '3d-asset',
    'audio-generation',
    'workflow-jobs'
  ],
  'higgsfield-soul-id': ['identity-generation', 'soul-listing', 'soul-style-presets']
};

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const CODE_PATH = /`([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*\.md)`/g;
const ENDPOINT_VALUE = /"endpoint"\s*:\s*"([^"\s]+)"/g;

interface Frontmatter {
  block: string;
  body: string;
}

function splitFrontmatter(text: string): Frontmatter | undefined {
  if (!text.startsWith('---\n')) return undefined;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return undefined;
  return { block: text.slice(4, end), body: text.slice(end + 5) };
}

function scalar(block: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(block);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

interface McpBlock {
  required?: boolean | undefined;
  minimumVersion?: string | undefined;
  tools: string[];
}

function parseMcpBlock(block: string): McpBlock | undefined {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => line.startsWith('x-higgsfield-mcp:'));
  if (start === -1) return undefined;
  const parsed: McpBlock = { tools: [] };
  let inTools = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.length > 0 && !line.startsWith(' ')) break;
    const trimmed = line.trim();
    if (trimmed === 'tools:') {
      inTools = true;
      continue;
    }
    if (inTools && trimmed.startsWith('- ')) {
      parsed.tools.push(trimmed.slice(2).trim());
      continue;
    }
    inTools = false;
    const required = /^required:\s*(true|false)$/.exec(trimmed);
    if (required !== null) parsed.required = required[1] === 'true';
    const version = /^minimum-version:\s*(\S+)$/.exec(trimmed);
    if (version !== null) parsed.minimumVersion = version[1] as string;
  }
  return parsed;
}

function checkFrontmatter(entry: SkillManifestEntry, text: string, dir: string, errors: string[]): void {
  const frontmatter = splitFrontmatter(text);
  if (frontmatter === undefined) {
    errors.push(`${dir}: SKILL.md has no YAML frontmatter.`);
    return;
  }
  const name = scalar(frontmatter.block, 'name');
  if (name !== entry.name) errors.push(`${dir}: frontmatter name "${String(name)}" does not match the skill directory "${entry.name}".`);
  if (scalar(frontmatter.block, 'description') === undefined) {
    errors.push(`${dir}: frontmatter has no description.`);
  }
  const mcp = parseMcpBlock(frontmatter.block);
  if (mcp === undefined) {
    errors.push(`${dir}: frontmatter has no x-higgsfield-mcp block.`);
    return;
  }
  if (mcp.required !== true) errors.push(`${dir}: x-higgsfield-mcp.required must be true.`);
  if (mcp.minimumVersion !== '0.1.0') errors.push(`${dir}: x-higgsfield-mcp.minimum-version must be 0.1.0 (got ${String(mcp.minimumVersion)}).`);
  if (mcp.tools.length === 0) errors.push(`${dir}: x-higgsfield-mcp.tools is empty.`);
  for (const tool of mcp.tools) {
    if (!isKnownTool(tool)) errors.push(`${dir}: x-higgsfield-mcp declares unknown tool "${tool}" (known: ${KNOWN_TOOLS.length}).`);
  }
  const declared = [...mcp.tools].sort().join(',');
  const pinned = [...entry.requiredTools].sort().join(',');
  if (declared !== pinned) {
    errors.push(`${dir}: x-higgsfield-mcp.tools (${declared}) do not match manifest requiredTools (${pinned}).`);
  }
  const allowed = scalar(frontmatter.block, 'allowed-tools');
  if (allowed !== entry.requiredTools.join(', ')) {
    errors.push(`${dir}: allowed-tools must list exactly the declared MCP tools.`);
  }
}

function checkLinks(file: string, relativePath: string, text: string, tree: Set<string>, errors: string[]): void {
  const seen = new Set<string>();
  for (const pattern of [LINK, CODE_PATH]) {
    for (const match of text.matchAll(pattern)) {
      const target = match[1] as string;
      if (seen.has(target)) continue;
      seen.add(target);
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const resolved = normalize(join(dirname(relativePath), target)).split(sep).join('/');
      if (resolved.startsWith('..')) {
        errors.push(`${file}: reference "${target}" resolves outside the generated tree.`);
        continue;
      }
      if (!tree.has(resolved)) errors.push(`${file}: reference "${target}" does not resolve inside the generated tree.`);
    }
  }
}

function checkContent(file: string, text: string, ruleSet: PatchRuleSet, registryEndpointIds: string[], errors: string[]): void {
  for (const forbidden of ruleSet.forbidden) {
    const match = new RegExp(forbidden.pattern).exec(text);
    if (match !== null) {
      const line = text.slice(0, match.index).split('\n').length;
      errors.push(`${file}:${line}: generated content contains ${forbidden.reason} (${JSON.stringify(match[0])}).`);
    }
  }
  const known = new Set([...registryEndpointIds, 'image.default', 'image.edit', 'video.default', 'video.image_to_video', 'video.reference_to_video']);
  for (const match of text.matchAll(ENDPOINT_VALUE)) {
    const endpoint = match[1] as string;
    if (known.has(endpoint) || isSemanticRoute(endpoint)) continue;
    errors.push(`${file}: endpoint "${endpoint}" is not in the registry catalog.`);
  }
}

function checkPinnedSource(manifest: SkillManifest, repoRoot: string, errors: string[], warnings: string[]): void {
  const sourceRoot = join(repoRoot, 'packages', 'skills', 'source');
  for (const skill of manifest.skills) {
    const dir = join(sourceRoot, skill.name);
    const pinned = Object.keys(skill.sourceHashes);
    for (const relativePath of pinned) {
      const file = join(dir, relativePath);
      if (!existsSync(file)) {
        errors.push(`source/${skill.name}/${relativePath}: pinned in the manifest but missing from the vendored tree.`);
        continue;
      }
      const actual = sha256Hex(readFileSync(file));
      const expected = skill.sourceHashes[relativePath] as string;
      if (actual !== expected) {
        errors.push(`source/${skill.name}/${relativePath}: hash ${actual.slice(0, 16)}… does not match the pinned ${expected.slice(0, 16)}….`);
      }
    }
    for (const relativePath of listTree(dir)) {
      if (!pinned.includes(relativePath)) warnings.push(`source/${skill.name}/${relativePath}: vendored but not pinned in sourceHashes.`);
    }
  }
}

function checkGeneratedTree(manifest: SkillManifest, options: ValidateOptions, ruleSet: PatchRuleSet, errors: string[], warnings: string[]): void {
  const tree = new Set(listTree(options.skillsDir));
  for (const skill of manifest.skills) {
    const relativeSkillFile = `${skill.name}/SKILL.md`;
    const ships = skill.status === 'compatible' || skill.status === 'partial';
    if (!ships) {
      if (tree.has(relativeSkillFile)) {
        errors.push(`${relativeSkillFile}: "${skill.name}" is ${skill.status} and must not ship a generated skill.`);
      }
      continue;
    }
    if (!tree.has(relativeSkillFile)) {
      errors.push(`${relativeSkillFile}: missing from the generated tree, but "${skill.name}" is ${skill.status}.`);
      continue;
    }
    const file = join(options.skillsDir, relativeSkillFile);
    const text = readFileSync(file, 'utf8');
    checkFrontmatter(skill, text, relativeSkillFile, errors);
    try {
      evaluateSkillDocument(text, relativeSkillFile, skill.name, {
        unavailableRequests: ROUTING_REQUIREMENTS[skill.name] ?? [],
        requiresAssetChain: true
      });
    } catch (error) {
      errors.push(error instanceof SkillsError ? error.message : `${relativeSkillFile}: trace evaluation failed (${String(error)}).`);
    }
    for (const referenced of listTree(join(options.skillsDir, skill.name))) {
      const relativePath = `${skill.name}/${referenced}`;
      checkContent(relativePath, readFileSync(join(options.skillsDir, relativePath), 'utf8'), ruleSet, options.registryEndpointIds, errors);
    }
  }
  for (const relativePath of tree) {
    if (!relativePath.endsWith('.md')) continue;
    const declared = manifest.skills.some((skill) => relativePath.startsWith(`${skill.name}/`));
    if (!declared) {
      warnings.push(`${relativePath}: generated file does not belong to a classified skill.`);
      continue;
    }
    checkLinks(relativePath, relativePath, readFileSync(join(options.skillsDir, relativePath), 'utf8'), tree, errors);
  }
}

export async function validateSkills(options: ValidateOptions): Promise<ValidateResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let manifest: SkillManifest;
  try {
    manifest = loadManifest(options.skillsDir);
  } catch (error) {
    return { errors: [`${options.skillsDir}: ${(error as Error).message}`], warnings };
  }

  const repoManifest = join(options.repoRoot, 'packages', 'skills', 'manifest.json');
  if (existsSync(repoManifest) && !existsSync(join(options.skillsDir, 'manifest.json'))) {
    errors.push(`${options.skillsDir}: no manifest.json in the generated tree.`);
  } else if (existsSync(repoManifest)) {
    const shipped = readFileSync(join(options.skillsDir, 'manifest.json'), 'utf8');
    if (shipped !== readFileSync(repoManifest, 'utf8')) {
      errors.push('skills/manifest.json is not byte-identical to packages/skills/manifest.json (the generated tree must not be hand-edited).');
    }
  }

  let ruleSet: PatchRuleSet;
  try {
    ruleSet = loadRuleSet(join(options.repoRoot, 'packages', 'skills', 'patches'));
  } catch (error) {
    return { errors: [...errors, (error as Error).message], warnings };
  }
  if (ruleSet.upstreamCommit !== manifest.upstream.commit) {
    errors.push(`patches/rules.json pins ${ruleSet.upstreamCommit} but the manifest pins ${manifest.upstream.commit}.`);
  }

  checkPinnedSource(manifest, options.repoRoot, errors, warnings);
  checkGeneratedTree(manifest, options, ruleSet, errors, warnings);

  const generatedDir = join(options.repoRoot, 'packages', 'skills', 'generated');
  const shippedDir = join(options.repoRoot, 'skills');
  if (resolve(options.skillsDir) === resolve(shippedDir)) {
    if (!existsSync(generatedDir)) {
      warnings.push('packages/skills/generated is absent: the shipped tree could not be compared against a fresh generation.');
    } else {
      const staged = readTree(generatedDir);
      const shipped = readTree(options.skillsDir);
      for (const [relativePath, content] of staged) {
        const other = shipped.get(relativePath);
        if (other === undefined) errors.push(`generated/${relativePath} is missing from the shipped tree.`);
        else if (other !== content) errors.push(`generated/${relativePath} differs from the shipped copy (run pnpm skills:sync).`);
      }
      for (const relativePath of shipped.keys()) {
        if (!staged.has(relativePath)) errors.push(`${relativePath} is shipped but absent from packages/skills/generated.`);
      }
    }
  }

  return { errors, warnings };
}
