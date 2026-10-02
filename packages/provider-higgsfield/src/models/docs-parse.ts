/**
 * Markdown parsing for the provider's public documentation directory.
 *
 * Pure functions over page text: no I/O, no evaluation, no inference. Section
 * boundaries are same-or-higher headings found *outside* fenced code, so a heading
 * quoted inside an example can never split a document. Everything the crawler
 * needs is read from an explicitly labeled heading, table column or accordion —
 * never from prose, never from a URL slug, and never by asking a model.
 */

interface Line {
  text: string;
  /** Offset of the line start in the document. */
  start: number;
  /** Offset just past the line end (before the newline). */
  end: number;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

function toLines(markdown: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const text of markdown.split('\n')) {
    lines.push({ text, start, end: start + text.length });
    start += text.length + 1;
  }
  return lines;
}

interface Heading {
  level: number;
  title: string;
  /** Offset of the heading line start. */
  start: number;
  /** Offset just past the heading line. */
  lineEnd: number;
}

/** Headings outside fenced code blocks, in document order. */
function headings(lines: readonly Line[]): Heading[] {
  const found: Heading[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const marker = FENCE.exec(line.text);
    if (marker !== null) {
      const token = marker[1] as string;
      if (fence === undefined) fence = token.slice(0, 1);
      else if (token.startsWith(fence)) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const match = HEADING.exec(line.text);
    if (match === null) continue;
    found.push({
      level: (match[1] as string).length,
      title: (match[2] as string).trim(),
      start: line.start,
      lineEnd: line.end
    });
  }
  return found;
}

/**
 * Body of the first heading titled `title` at `level`, running to the next heading
 * of the same or higher level. `undefined` when the section is absent.
 */
export function findSection(markdown: string, title: string, level = 2): string | undefined {
  const lines = toLines(markdown);
  const found = headings(lines);
  const index = found.findIndex((heading) => heading.level === level && heading.title === title);
  if (index === -1) return undefined;
  const heading = found[index] as Heading;
  for (let next = index + 1; next < found.length; next += 1) {
    const candidate = found[next] as Heading;
    if (candidate.level <= level) return markdown.slice(heading.lineEnd, candidate.start);
  }
  return markdown.slice(heading.lineEnd);
}

/** First heading of the given level, used for documented workflow names. */
export function firstHeadingTitle(markdown: string, level = 1): string | undefined {
  const heading = headings(toLines(markdown)).find((candidate) => candidate.level === level);
  const title = heading?.title;
  return title === undefined || title.length === 0 ? undefined : title;
}

export interface DocumentedLink {
  /** Link text (empty for a raw HTML anchor). */
  text: string;
  /** Link target exactly as written. */
  target: string;
}

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/g;
const HTML_ANCHOR_HREF = /\bhref="([^"]*)"/g;

/**
 * Removes fenced code blocks. Examples inside a fence are documentation prose, not
 * directory structure: a sample request or a quoted table must never be read as a link
 * or a workflow row.
 */
export function stripFencedBlocks(markdown: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of toLines(markdown)) {
    const marker = FENCE.exec(line.text);
    if (marker !== null) {
      const token = marker[1] as string;
      if (fence === undefined) fence = token.slice(0, 1);
      else if (token.startsWith(fence)) fence = undefined;
      continue;
    }
    if (fence === undefined) kept.push(line.text);
  }
  return kept.join('\n');
}

/** Markdown links and HTML `href` anchors in `section`, in document order. */
export function extractLinks(section: string): DocumentedLink[] {
  const body = stripFencedBlocks(section);
  const found: { index: number; link: DocumentedLink }[] = [];
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const target = match[2];
    if (target === undefined) continue;
    found.push({ index: match.index, link: { text: (match[1] ?? '').trim(), target } });
  }
  for (const match of body.matchAll(HTML_ANCHOR_HREF)) {
    const target = match[1];
    if (target === undefined) continue;
    found.push({ index: match.index, link: { text: '', target } });
  }
  found.sort((left, right) => left.index - right.index);
  return found.map((entry) => entry.link);
}

export interface WorkflowTableRow {
  /** Documented workflow label (the link text). */
  name: string;
  /** Link target of the workflow page. */
  target: string;
  /** Endpoint id as written in the endpoint column, with the `POST /` prefix removed. */
  endpoint: string | null;
}

const ENDPOINT_CELL = /`[A-Za-z]+[ \t]+(\/\S+?)`/;

/**
 * Workflow rows of a family page's `Workflows` table. A row whose endpoint column
 * carries no endpoint keeps `endpoint: null`; the caller decides how to treat it.
 */
export function parseWorkflowTable(section: string): WorkflowTableRow[] {
  const rows: WorkflowTableRow[] = [];
  for (const rawLine of stripFencedBlocks(section).split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
    if (cells.length !== 2) continue;
    const [first, second] = cells as [string, string];
    if (/^[-: ]*$/.test(first.replaceAll('|', ''))) continue;
    const link = /\[([^\]]*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/.exec(first);
    if (link === null) continue;
    if (first.toLowerCase() === 'workflow') continue;
    const endpointMatch = ENDPOINT_CELL.exec(second);
    const endpoint = endpointMatch?.[1];
    rows.push({
      name: (link[1] ?? '').trim(),
      target: link[2] as string,
      endpoint: endpoint === undefined ? null : endpoint.replace(/^\//, '')
    });
  }
  return rows;
}

export interface EndpointMetadata {
  /** Value of a labeled `Endpoint ID` field, when the page publishes one. */
  endpointId?: string | undefined;
  /** Absolute endpoint URL from a labeled `Endpoint` field. */
  endpointUrl?: string | undefined;
}

const ENDPOINT_ID = /\*\*Endpoint ID:\*\*[ \t]*`([^`]+)`/;
const ENDPOINT_URL = /\*\*Endpoint:\*\*[ \t]*`[A-Za-z]+[ \t]+(\S+?)`/;

/**
 * Explicitly labeled endpoint metadata. Values are returned verbatim; the caller
 * validates them, so a page can never hand the adapter an unchecked identifier.
 */
export function extractEndpointMetadata(markdown: string): EndpointMetadata {
  const metadata: EndpointMetadata = {};
  const id = ENDPOINT_ID.exec(markdown)?.[1];
  if (id !== undefined) metadata.endpointId = id.trim();
  const url = ENDPOINT_URL.exec(markdown)?.[1];
  if (url !== undefined) metadata.endpointUrl = url.trim();
  return metadata;
}

export type SchemaExtraction =
  | { ok: true; schema: Record<string, unknown> }
  | { ok: false; reason: 'schema_missing' | 'schema_invalid' };

const SCHEMA_ACCORDION_OPEN = '<Accordion title="Complete JSON schema">';
const JSON_FENCE = /```json[^\n]*\n([\s\S]*?)\n[ \t]*```/;

/**
 * The workflow's published input schema, read only from the `Complete JSON schema`
 * accordion and parsed with `JSON.parse` — never evaluated, never inferred.
 */
export function extractCompleteSchema(markdown: string): SchemaExtraction {
  const open = markdown.indexOf(SCHEMA_ACCORDION_OPEN);
  if (open === -1) return { ok: false, reason: 'schema_missing' };
  const close = markdown.indexOf('</Accordion>', open);
  const body = markdown.slice(open + SCHEMA_ACCORDION_OPEN.length, close === -1 ? undefined : close);
  const fence = JSON_FENCE.exec(body);
  const json = fence?.[1];
  if (json === undefined) return { ok: false, reason: 'schema_missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'schema_invalid' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'schema_invalid' };
  }
  return { ok: true, schema: parsed as Record<string, unknown> };
}

function resolveLocalPointer(root: Record<string, unknown>, pointer: string): boolean {
  let current: unknown = root;
  for (const rawSegment of pointer.slice(2).split('/')) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}

/**
 * Checks that every `$ref` in the schema is a local pointer that resolves. External
 * or unresolved references make the schema unusable, because a resolver the gateway
 * does not have would be required to interpret it.
 */
export function schemaReferenceProblem(root: Record<string, unknown>): string | undefined {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): string | undefined => {
    if (depth > 24) return 'schema_too_deep';
    if (typeof node !== 'object' || node === null) return undefined;
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const problem = walk(item, depth + 1);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    const record = node as Record<string, unknown>;
    const ref = record['$ref'];
    if (typeof ref === 'string') {
      if (!ref.startsWith('#/')) return 'schema_reference_external';
      if (!resolveLocalPointer(root, ref)) return 'schema_reference_unresolved';
    }
    for (const value of Object.values(record)) {
      const problem = walk(value, depth + 1);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  return walk(root, 0);
}

/**
 * Structural comparison of two documented JSON Schemas. Key order, `title` and
 * `description` are descriptive metadata; every other keyword — defaults, enums,
 * required fields, limits, formats and conditional constraints — is significant.
 */
export function canonicalSchemaJson(schema: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value !== 'object' || value === null) return value;
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (key === 'title' || key === 'description') continue;
      out[key] = canonical(record[key]);
    }
    return out;
  };
  return JSON.stringify(canonical(schema));
}
