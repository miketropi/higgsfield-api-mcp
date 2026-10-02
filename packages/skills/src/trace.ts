import { z } from 'zod';
import { isKnownTool, TOOL_ROLE } from './tools.js';
import { SkillsError } from './errors.js';

/**
 * Deterministic trace evaluator for generated skills.
 *
 * A generated `SKILL.md` declares its workflow twice: as machine-readable call sites —
 * fenced JSON objects carrying a `"tool"` key — and as one `Execution trace` block listing
 * the ordered steps, the approval gates and the `asset_id` chains. The evaluator asserts
 * the properties a reader of the prose would otherwise have to trust:
 *
 * - discovery (`capabilities`, `models.*`) precedes every supported (spending) call;
 * - an approval checkpoint precedes the first spending call;
 * - media chains by `asset_id` from an earlier upload/get/job step;
 * - requests whose upstream workflow has no MCP equivalent are routed to an explicit
 *   `unavailable` entry instead of being simulated.
 */

const traceSchema = z
  .object({
    skill: z.string().min(1),
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1),
            purpose: z.string().min(1),
            tool: z.string().min(1).optional(),
            gate: z.literal('approval').optional(),
            chained_from: z.object({ step: z.string().min(1), field: z.literal('asset_id') }).strict().optional()
          })
          .strict()
      )
      .min(1),
    routing: z
      .array(z.object({ request: z.string().min(1), outcome: z.literal('unavailable'), reason: z.string().min(40) }).strict())
      .min(1)
  })
  .strict();

export type SkillTrace = z.infer<typeof traceSchema>;
export type TraceStep = SkillTrace['steps'][number];
export type TraceRouting = SkillTrace['routing'][number];

const TRACE_HEADING = '## Execution trace';
const APPROVAL_MARKER = /\b(approval|approved|confirm|confirmation_token|confirmation_required)\b/i;
const FENCED_BLOCK = /^```[a-z]*\n([\s\S]*?)^```$/gm;
const CALL_SITE = /"tool"\s*:\s*"(higgsfield\.[a-z_.]+)"/g;

/** Every fenced block whose body parses as a JSON object, in document order, with its offset. */
export function parseFencedObjects(markdown: string): { value: Record<string, unknown>; index: number }[] {
  const found: { value: Record<string, unknown>; index: number }[] = [];
  for (const match of markdown.matchAll(FENCED_BLOCK)) {
    const body = match[1] as string;
    const index = (match.index ?? 0) + (match[0] as string).indexOf(body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      found.push({ value: parsed as Record<string, unknown>, index });
    }
  }
  return found;
}

export function parseTrace(markdown: string, file: string): SkillTrace {
  const candidates = parseFencedObjects(markdown).filter((block) => 'steps' in block.value);
  if (candidates.length !== 1) {
    throw new SkillsError(`${file}: expected exactly one execution-trace block, found ${candidates.length}.`);
  }
  const result = traceSchema.safeParse((candidates[0] as { value: unknown }).value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new SkillsError(
      `${file}: execution trace is invalid at ${issue === undefined ? '(root)' : issue.path.join('.')} — ${
        issue === undefined ? 'parse failed' : issue.message
      }.`
    );
  }
  return result.data;
}

/** Ordered call sites: the `"tool": "higgsfield.…"` occurrences, in document order, deduplicated. */
export function extractToolCalls(markdown: string): { tool: string; index: number }[] {
  const calls: { tool: string; index: number }[] = [];
  for (const match of markdown.matchAll(CALL_SITE)) {
    const tool = match[1] as string;
    if (calls.some((call) => call.tool === tool)) continue;
    calls.push({ tool, index: match.index ?? 0 });
  }
  return calls;
}

function firstOffset(calls: { tool: string; index: number }[], role: 'discovery' | 'spend'): number | undefined {
  return calls.find((call) => TOOL_ROLE[call.tool] === role)?.index;
}

export interface SkillDocumentChecks {
  /** Request keys that must appear in the routing table as unavailable. */
  unavailableRequests: string[];
  /** The skill must demonstrate a media reference chained by asset_id. */
  requiresAssetChain: boolean;
}

/**
 * Structural assertions that hold for any generated skill document. Throws with the file,
 * the failing invariant and the evidence.
 */
export function evaluateSkillDocument(markdown: string, file: string, skillName: string, checks: SkillDocumentChecks): void {
  const trace = parseTrace(markdown, file);
  if (trace.skill !== skillName) {
    throw new SkillsError(`${file}: execution trace declares skill "${trace.skill}" but the directory is "${skillName}".`);
  }
  if (!markdown.includes(TRACE_HEADING)) throw new SkillsError(`${file}: the execution trace needs a "${TRACE_HEADING}" heading.`);

  const stepIndexById = new Map<string, number>();
  trace.steps.forEach((step, index) => stepIndexById.set(step.id, index));

  const roles = trace.steps.map((step) => (step.tool === undefined ? undefined : TOOL_ROLE[step.tool]));
  trace.steps.forEach((step) => {
    if (step.tool !== undefined && !isKnownTool(step.tool)) {
      throw new SkillsError(`${file}: trace step "${step.id}" declares unknown tool ${step.tool}.`);
    }
  });
  const firstDiscovery = roles.indexOf('discovery');
  const firstSpend = roles.indexOf('spend');
  const firstGate = trace.steps.findIndex((step) => step.gate === 'approval');
  if (firstSpend === -1) throw new SkillsError(`${file}: the execution trace declares no spending call.`);
  if (firstDiscovery === -1 || firstDiscovery > firstSpend) {
    throw new SkillsError(`${file}: discovery must precede the first spending call (discovery ${firstDiscovery}, spend ${firstSpend}).`);
  }
  if (firstGate === -1 || firstGate > firstSpend) {
    throw new SkillsError(`${file}: an approval checkpoint must precede the first spending call (gate ${firstGate}, spend ${firstSpend}).`);
  }

  let chained = 0;
  trace.steps.forEach((step, index) => {
    const chain = step.chained_from;
    if (chain === undefined) return;
    const source = stepIndexById.get(chain.step);
    if (source === undefined || source >= index) {
      throw new SkillsError(`${file}: trace step "${step.id}" chains from "${chain.step}", which is not an earlier step.`);
    }
    const producer = (trace.steps[source] as TraceStep).tool ?? '';
    if (!['higgsfield.media.upload', 'higgsfield.media.get', 'higgsfield.jobs.wait', 'higgsfield.jobs.get'].includes(producer)) {
      throw new SkillsError(`${file}: trace step "${step.id}" must chain asset_id from an upload/get/job step, not from "${producer}".`);
    }
    chained += 1;
  });
  if (checks.requiresAssetChain && chained === 0) {
    throw new SkillsError(`${file}: the execution trace must chain at least one call by asset_id.`);
  }

  const calls = extractToolCalls(markdown);
  const callDiscovery = firstOffset(calls, 'discovery');
  const callSpend = firstOffset(calls, 'spend');
  if (callSpend === undefined) throw new SkillsError(`${file}: no spending call site is documented.`);
  if (callDiscovery === undefined || callDiscovery > callSpend) {
    throw new SkillsError(`${file}: the first documented call site must be a discovery call.`);
  }
  const approval = APPROVAL_MARKER.exec(markdown);
  if (approval === null || approval.index > callSpend) {
    throw new SkillsError(`${file}: an approval checkpoint must be documented before the first spending call site.`);
  }

  for (const request of checks.unavailableRequests) {
    if (!trace.routing.some((route) => route.request === request)) {
      throw new SkillsError(`${file}: routing has no "${request}" entry.`);
    }
  }
  const executed = trace.steps.map((step) => step.id);
  const overlapping = trace.routing.find((route) => executed.includes(route.request));
  if (overlapping !== undefined) {
    throw new SkillsError(`${file}: unavailable request "${overlapping.request}" is also declared as an executed step.`);
  }
}
