import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateSkillDocument, extractToolCalls, parseTrace } from '@higgsfield-mcp/skills';
import { KNOWN_TOOLS } from '@higgsfield-mcp/skills';
import { listTree, readText, SKILLS_DIR } from '../unit/skills/helpers.js';

/**
 * Scenario evals: the generated skills are read as the agent would read them. Tool calls are the
 * fenced JSON call sites, in document order; the execution trace declares the workflow contract.
 */
const CLI_INVOCATION = /\bhiggsfield\s+(?:generate|model|soul-id|upload|preset|workflow|marketing-studio|product-photoshoot|marketplace-cards|website|voices|account|auth|game|explainer|cost)\b/;

const GENERATE = join(SKILLS_DIR, 'higgsfield-generate', 'SKILL.md');
const SOUL = join(SKILLS_DIR, 'higgsfield-soul-id', 'SKILL.md');

const GENERATE_ROUTING = [
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
];

describe('generic image → video scenario', () => {
  const document = readText(GENERATE);

  it('satisfies every trace invariant', () => {
    expect(() =>
      evaluateSkillDocument(document, 'higgsfield-generate/SKILL.md', 'higgsfield-generate', {
        unavailableRequests: GENERATE_ROUTING,
        requiresAssetChain: true
      })
    ).not.toThrow();
  });

  it('discovers before it spends and gates the spend behind an approval checkpoint', () => {
    const trace = parseTrace(document, 'generate');
    const ids = trace.steps.map((step) => step.id);
    expect(ids.indexOf('read-model')).toBeLessThan(ids.indexOf('generate-image'));
    expect(ids.indexOf('approve-image')).toBeLessThan(ids.indexOf('generate-image'));
    expect(ids.indexOf('approve-video')).toBeLessThan(ids.indexOf('generate-video'));
    expect(extractToolCalls(document)[0]?.tool).toBe('higgsfield.capabilities');
  });

  it('chains generated media into the video call by asset_id', () => {
    const trace = parseTrace(document, 'generate');
    const byId = new Map(trace.steps.map((step) => [step.id, step]));
    expect(byId.get('generate-image')?.chained_from).toEqual({ step: 'upload-reference', field: 'asset_id' });
    expect(byId.get('read-asset')?.chained_from).toEqual({ step: 'await-image', field: 'asset_id' });
    expect(byId.get('generate-video')?.chained_from).toEqual({ step: 'read-asset', field: 'asset_id' });
    expect(document).toContain('"asset_id"');
  });

  it('only ever calls tools from the frozen MCP contract', () => {
    for (const call of extractToolCalls(document)) expect(KNOWN_TOOLS).toContain(call.tool as (typeof KNOWN_TOOLS)[number]);
  });

  it('never invokes the Higgsfield CLI', () => {
    expect(CLI_INVOCATION.test(document)).toBe(false);
    expect(document).not.toMatch(/install\.sh|curl[^\n]*\|\s*sh|npm\s+install/);
  });
});

describe('product-photoshoot request', () => {
  const document = readText(GENERATE);

  it('is answered with an explicit "workflow unavailable", not a simulated parity claim', () => {
    const route = parseTrace(document, 'generate').routing.find((entry) => entry.request === 'product-photoshoot');
    expect(route?.outcome).toBe('unavailable');
    expect(route?.reason).toMatch(/prompt enhancer/);
    // No call site simulates it, and the instruction to refuse is explicit.
    expect(extractToolCalls(document).some((call) => /photoshoot|marketplace|brandkit/.test(call.tool))).toBe(false);
    expect(document).toMatch(/product-photoshoot[\s\S]{0,600}unavailable/i);
    expect(document).toMatch(/Do not re-route it to an unrelated model/);
  });
});

describe('soul training → identity generation scenario', () => {
  const document = readText(SOUL);

  it('trains through the catalog endpoint after discovery and approval', () => {
    const trace = parseTrace(document, 'soul');
    const ids = trace.steps.map((step) => step.id);
    const train = trace.steps.find((step) => step.id === 'train');
    expect(train?.tool).toBe('higgsfield.generate');
    expect(ids.indexOf('discover-gateway')).toBeLessThan(ids.indexOf('train'));
    expect(ids.indexOf('upload-photos')).toBeLessThan(ids.indexOf('resolve-photos'));
    expect(ids.indexOf('approve-training')).toBeLessThan(ids.indexOf('train'));
    expect(trace.steps.find((step) => step.id === 'resolve-photos')?.chained_from).toEqual({ step: 'upload-photos', field: 'asset_id' });
    expect(trace.steps.find((step) => step.id === 'train')?.chained_from).toEqual({ step: 'resolve-photos', field: 'asset_id' });
    expect(document).toContain('"endpoint": "v1/custom-references"');
  });

  it('declares identity generation unavailable instead of faking it', () => {
    const route = parseTrace(document, 'soul').routing.find((entry) => entry.request === 'identity-generation');
    expect(route?.outcome).toBe('unavailable');
    expect(route?.reason).toMatch(/custom_reference_id/);
    expect(document).toMatch(/## Use the Soul — unavailable/);
    expect(document).toMatch(/not available through the gateway/);
    expect(() =>
      evaluateSkillDocument(document, 'higgsfield-soul-id/SKILL.md', 'higgsfield-soul-id', {
        unavailableRequests: ['identity-generation', 'soul-listing', 'soul-style-presets'],
        requiresAssetChain: true
      })
    ).not.toThrow();
  });

  it('never invokes the Higgsfield CLI', () => {
    expect(CLI_INVOCATION.test(document)).toBe(false);
  });
});

describe('the generated wait guidance', () => {
  it('never promises a wait longer than the gateway allows, and names the authoritative limit', () => {
    const docs = listTree(SKILLS_DIR).filter((path) => path.endsWith('.md'));
    let documentsWithWaitGuidance = 0;
    for (const file of docs) {
      const text = readFileSync(join(SKILLS_DIR, file), 'utf8');
      for (const match of text.matchAll(/"timeout_ms":\s*(\d+)/g)) {
        // packages/mcp/src/server.ts clamps timeout_ms to capabilities.limits.max_wait_ms (25 s shipped).
        expect(Number(match[1]), file).toBeLessThanOrEqual(25_000);
      }
      if (!/jobs\.wait/.test(text)) continue;
      documentsWithWaitGuidance += 1;
      expect(text, file).toMatch(/max_wait_ms/);
      expect(text, file).not.toMatch(/1_800_000|30 minutes|longer timeout|"timeout_ms": 120000/);
    }
    expect(documentsWithWaitGuidance).toBeGreaterThanOrEqual(5);
  });
});

describe('the whole generated tree', () => {
  it('contains no CLI invocation, installer or network bootstrap', () => {
    const files = listTree(SKILLS_DIR).filter((path) => path.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const text = readFileSync(join(SKILLS_DIR, file), 'utf8');
      expect(CLI_INVOCATION.test(text), file).toBe(false);
      expect(text, file).not.toMatch(/install\.sh|curl[^\n]*\|\s*sh|npm\s+install|pip\s+install/);
    }
  });
});
