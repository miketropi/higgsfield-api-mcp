import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SkillsError } from './errors.js';
import type { SkillManifest, SkillManifestEntry } from './manifest.js';

/**
 * Deterministic patch engine: literal replacements with asserted occurrence counts.
 *
 * Every rule states how many times its anchor must appear in the pinned upstream file.
 * A count mismatch — an upstream edit, a deleted hunk, a stale fragment — aborts the
 * sync instead of shipping a half-patched skill. Nothing here interprets Markdown
 * beyond the anchors it is told about.
 */
export interface PatchRule {
  id: string;
  kind: 'replace-text' | 'replace-section' | 'insert-after';
  from?: string | undefined;
  to?: string | undefined;
  anchor?: string | undefined;
  fragment?: string | undefined;
  expected: number;
}

export interface PatchDocument {
  skill: string;
  source: string;
  output: string;
  frontmatter: boolean;
  rules: PatchRule[];
}

export interface PatchCopy {
  skill: string;
  source: string;
  output: string;
}

export interface PatchSkip {
  skill: string;
  source: string;
  reason: string;
}

export interface PatchRuleSet {
  adapterVersion: string;
  upstreamCommit: string;
  documents: PatchDocument[];
  copy: PatchCopy[];
  skip: PatchSkip[];
  forbidden: { pattern: string; reason: string }[];
}

const ruleSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['replace-text', 'replace-section', 'insert-after']),
    from: z.string().min(1).optional(),
    to: z.string().optional(),
    anchor: z.string().min(1).optional(),
    fragment: z.string().min(1).optional(),
    expected: z.number().int().nonnegative()
  })
  .strict();

const ruleSetSchema = z
  .object({
    adapterVersion: z.string().min(1),
    upstreamCommit: z.string().regex(/^[0-9a-f]{40}$/),
    documents: z.array(
      z
        .object({
          skill: z.string().min(1),
          source: z.string().min(1),
          output: z.string().min(1),
          frontmatter: z.boolean(),
          rules: z.array(ruleSchema)
        })
        .strict()
    ),
    copy: z.array(z.object({ skill: z.string().min(1), source: z.string().min(1), output: z.string().min(1) }).strict()),
    skip: z.array(z.object({ skill: z.string().min(1), source: z.string().min(1), reason: z.string().min(1) }).strict()),
    forbidden: z.array(z.object({ pattern: z.string().min(1), reason: z.string().min(1) }).strict())
  })
  .strict();

function readRuleFile(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text) as unknown;
}

export function loadRuleSet(patchesDir: string): PatchRuleSet {
  const path = join(patchesDir, 'rules.json');
  let parsed: unknown;
  try {
    parsed = readRuleFile(path);
  } catch (error) {
    throw new SkillsError(`${path}: cannot read the patch rule set (${(error as Error).message}).`);
  }
  const result = ruleSetSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new SkillsError(
      `${path}: rule set is invalid at ${issue === undefined ? '(root)' : issue.path.join('.')} — ${
        issue === undefined ? 'parse failed' : issue.message
      }.`
    );
  }
  const ruleSet = result.data as PatchRuleSet;
  for (const document of ruleSet.documents) {
    for (const rule of document.rules) {
      if (rule.kind === 'replace-text' && (rule.from === undefined || (rule.to === undefined && rule.fragment === undefined))) {
        throw new SkillsError(`${path}: rule "${rule.id}" needs "from" and either "to" or "fragment".`);
      }
      if (rule.kind !== 'replace-text' && rule.anchor === undefined) {
        throw new SkillsError(`${path}: rule "${rule.id}" (${rule.kind}) needs an "anchor".`);
      }
      if (rule.kind !== 'replace-text' && rule.fragment === undefined) {
        throw new SkillsError(`${path}: rule "${rule.id}" (${rule.kind}) needs a "fragment".`);
      }
    }
  }
  return ruleSet;
}

export function loadFragments(patchesDir: string, ruleSet: PatchRuleSet): Map<string, string> {
  const names = new Set<string>();
  for (const document of ruleSet.documents) {
    for (const rule of document.rules) if (rule.fragment !== undefined) names.add(rule.fragment);
  }
  const fragments = new Map<string, string>();
  for (const name of names) {
    const path = join(patchesDir, 'fragments', name);
    try {
      fragments.set(name, readFileSync(path, 'utf8').replace(/\n+$/, ''));
    } catch (error) {
      throw new SkillsError(`${path}: cannot read the fragment referenced by the rule set (${(error as Error).message}).`);
    }
  }
  return fragments;
}

function countOf(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function assertCount(rule: PatchRule, file: string, actual: number): void {
  if (actual !== rule.expected) {
    throw new SkillsError(
      `${file}: patch rule "${rule.id}" matched ${actual} time(s), expected ${rule.expected}. ` +
        'The pinned upstream file or the patch rule changed — review the diff before syncing.'
    );
  }
}

function applyReplaceText(text: string, rule: PatchRule, file: string, fragments: Map<string, string>): string {
  const from = rule.from as string;
  assertCount(rule, file, countOf(text, from));
  const replacement = rule.fragment === undefined ? (rule.to as string) : (fragments.get(rule.fragment) as string);
  return text.split(from).join(replacement);
}

export function findSection(text: string, anchor: string, file: string, ruleId: string): { start: number; end: number } {
  const lines = text.split('\n');
  const start = lines.indexOf(anchor);
  if (start === -1) throw new SkillsError(`${file}: patch rule "${ruleId}" anchor not found: ${JSON.stringify(anchor)}.`);
  if (lines.indexOf(anchor, start + 1) !== -1) {
    throw new SkillsError(`${file}: patch rule "${ruleId}" anchor is ambiguous: ${JSON.stringify(anchor)}.`);
  }
  const level = (anchor.match(/^#+/) ?? [''])[0].length;
  let end = lines.length;
  let fenced = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    // A `#`-prefixed shell comment inside a fenced block is not a section boundary.
    const heading = fenced ? null : /^(#{1,6})\s/.exec(line);
    if (heading !== null && (heading[1] as string).length <= level) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function applyReplaceSection(text: string, rule: PatchRule, file: string, fragments: Map<string, string>): string {
  assertCount(rule, file, countOf(text, `${rule.anchor as string}\n`));
  const lines = text.split('\n');
  const { start, end } = findSection(text, rule.anchor as string, file, rule.id);
  const fragment = (fragments.get(rule.fragment as string) as string).split('\n');
  return [...lines.slice(0, start), ...fragment, '', ...lines.slice(end)].join('\n');
}

function applyInsertAfter(text: string, rule: PatchRule, file: string, fragments: Map<string, string>): string {
  assertCount(rule, file, countOf(text, `${rule.anchor as string}\n`));
  const lines = text.split('\n');
  const { start } = findSection(text, rule.anchor as string, file, rule.id);
  const fragment = (fragments.get(rule.fragment as string) as string).split('\n');
  return [...lines.slice(0, start + 1), '', ...fragment, ...lines.slice(start + 1)].join('\n');
}

const FRONTMATTER_KEEP = ['version', 'name', 'description', 'argument-hint'] as const;

/**
 * Keeps the upstream frontmatter keys verbatim, drops the CLI `allowed-tools` declaration,
 * and adds the `x-higgsfield-mcp` block that the gateway's skill validator requires.
 */
export function rewriteFrontmatter(text: string, tools: string[], provenance: string): string {
  const lines = text.split('\n');
  if (lines[0] !== '---') throw new SkillsError('Generated document has no YAML frontmatter to rewrite.');
  const closing = lines.indexOf('---', 1);
  if (closing === -1) throw new SkillsError('Generated document has an unterminated YAML frontmatter block.');
  const block = lines.slice(1, closing);
  const kept: string[] = [];
  for (let index = 0; index < block.length; index += 1) {
    const key = /^([a-z][a-z0-9-]*):/.exec(block[index] as string);
    if (key === null) continue;
    if (!FRONTMATTER_KEEP.includes(key[1] as (typeof FRONTMATTER_KEEP)[number])) continue;
    kept.push(block[index] as string);
    if ((block[index] as string).endsWith(': |')) {
      while (index + 1 < block.length && /^\s+\S/.test(block[index + 1] as string)) {
        index += 1;
        kept.push(block[index] as string);
      }
    }
  }
  const suffix = [
    '',
    `allowed-tools: ${tools.join(', ')}`,
    'x-higgsfield-mcp:',
    '  required: true',
    '  minimum-version: 0.1.0',
    '  tools:',
    ...tools.map((tool) => `    - ${tool}`)
  ];
  return ['---', ...kept, ...suffix, '---', provenance, ...lines.slice(closing + 1)].join('\n');
}

export interface BuiltSkill {
  files: Map<string, string>;
  skipped: { path: string; reason: string }[];
}

/** Applies the rule set for one skill and returns the generated files, keyed by output path. */
export function buildSkillFiles(
  entry: SkillManifestEntry,
  manifest: SkillManifest,
  ruleSet: PatchRuleSet,
  fragments: Map<string, string>,
  readSource: (skill: string, source: string) => string
): BuiltSkill {
  const documents = ruleSet.documents.filter((document) => document.skill === entry.name);
  const copies = ruleSet.copy.filter((item) => item.skill === entry.name);
  const skips = ruleSet.skip.filter((item) => item.skill === entry.name);
  const files = new Map<string, string>();

  for (const document of documents) {
    const label = `${entry.name}/${document.source}`;
    let body = readSource(entry.name, document.source);
    for (const rule of document.rules) {
      if (rule.kind === 'replace-text') body = applyReplaceText(body, rule, label, fragments);
      else if (rule.kind === 'replace-section') body = applyReplaceSection(body, rule, label, fragments);
      else body = applyInsertAfter(body, rule, label, fragments);
    }
    if (document.frontmatter) {
      body = rewriteFrontmatter(
        body,
        entry.requiredTools,
        `<!-- Generated by @higgsfield-mcp/skills ${manifest.adapterVersion} from ${manifest.upstream.repository}@${manifest.upstream.commit} (v${manifest.upstream.version}). Do not edit: edit packages/skills/patches and run pnpm skills:sync. -->`
      );
    }
    assertNoForbidden(body, document.output, ruleSet);
    files.set(document.output, body);
  }

  for (const item of copies) {
    const body = readSource(entry.name, item.source);
    assertNoForbidden(body, item.output, ruleSet);
    files.set(item.output, body);
  }

  return { files, skipped: skips.map((item) => ({ path: item.source, reason: item.reason })) };
}

export function assertNoForbidden(content: string, file: string, ruleSet: PatchRuleSet): void {
  for (const forbidden of ruleSet.forbidden) {
    const match = new RegExp(forbidden.pattern).exec(content);
    if (match !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      throw new SkillsError(`${file}:${line}: generated content contains ${forbidden.reason} (${JSON.stringify(match[0])}).`);
    }
  }
}
