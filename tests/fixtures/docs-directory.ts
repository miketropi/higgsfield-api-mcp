/**
 * Official-page fixtures for model discovery.
 *
 * The pages are generated in the exact shape of the live documentation directory
 * (`https://docs.higgsfield.ai/docs/models.md` → category → family → workflow), which is
 * what makes the crawler tests meaningful without touching the network: the same
 * headings, tables, labeled endpoint metadata, `Complete JSON schema` accordions and
 * `Related topics` sections the real site publishes.
 *
 * The fixture is mutable on purpose. A test can link a new workflow into a family page
 * mid-run and assert that the next refresh picks it up without editing any id list, or
 * redirect a page off-site and assert the crawler never follows it.
 */
import type { ModelDefinition } from '@higgsfield-mcp/core';
import type { HiggsfieldFetch } from '@higgsfield-mcp/provider-higgsfield';
import { TEST_CATALOG } from './fakes.js';

export const FIXTURE_DOCS_ORIGIN = 'https://docs.higgsfield.ai';

/** Manifest entry documented only on a preview origin, to exercise origin separation. */
const PREVIEW_MODEL: ModelDefinition = {
  id: 'fixture/preview-model',
  name: 'Fixture Preview Model',
  provider: 'higgsfield',
  type: 'video',
  endpoint: 'fixture/preview-model',
  kind: 'generation',
  concurrencyClass: 'video',
  capabilities: [],
  status: 'active',
  limits: {},
  inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
  source: { url: `${FIXTURE_DOCS_ORIGIN}/docs/models/fixture-preview.md`, asOf: '2026-10-02' }
};

/** Manifest entry whose documented schema has drifted, to exercise `schema_changed`. */
const DRIFT_MODEL: ModelDefinition = {
  id: 'fixture/drift-model',
  name: 'Fixture Drift Model',
  provider: 'higgsfield',
  type: 'image',
  endpoint: 'fixture/drift-model',
  kind: 'generation',
  concurrencyClass: 'image',
  capabilities: ['image_generation'],
  status: 'active',
  limits: {},
  inputSchema: {
    type: 'object',
    required: ['prompt'],
    properties: { prompt: { type: 'string', minLength: 1 } }
  },
  source: { url: `${FIXTURE_DOCS_ORIGIN}/docs/models/fixture-drift.md`, asOf: '2026-10-02' }
};

/** Manifest entry with no published schema, to exercise `schema_unavailable`. */
const NO_SCHEMA_MODEL: ModelDefinition = {
  id: 'fixture/no-schema',
  name: 'Fixture No Schema Model',
  provider: 'higgsfield',
  type: 'image',
  endpoint: 'fixture/no-schema',
  kind: 'generation',
  concurrencyClass: 'image',
  capabilities: ['image_generation'],
  status: 'active',
  limits: {},
  inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
  source: { url: `${FIXTURE_DOCS_ORIGIN}/docs/models/fixture-no-schema.md`, asOf: '2026-10-02' }
};

/** Execution manifest used by the discovery fixtures. */
export const FIXTURE_MANIFEST: readonly ModelDefinition[] = [
  ...TEST_CATALOG,
  PREVIEW_MODEL,
  DRIFT_MODEL,
  NO_SCHEMA_MODEL
];

export interface FixtureWorkflowSpec {
  /** Category the family hangs off. */
  type: 'image' | 'video';
  /** Family slug, i.e. the `/docs/models/<family>` page. */
  family: string;
  /** Model family title, as the category page lists it. */
  familyTitle: string;
  /** Workflow label in the family table. */
  label: string;
  /** Workflow documentation path below `/docs/models`, without the `.md` suffix. */
  path: string;
  /** Endpoint cell in the family table; `null` renders an empty cell. */
  listedEndpoint: string | null;
  /** Page `Endpoint ID` value; `null` omits the label entirely. */
  endpointId?: string | null | undefined;
  /** Page `Endpoint:` URL; `null` omits the label, `undefined` derives it from the endpoint. */
  endpointUrl?: string | null | undefined;
  /** Page H1, which discovery takes the workflow name from. */
  title: string;
  /** JSON schema body; `undefined` means the page publishes no schema accordion. */
  schema?: Record<string, unknown> | undefined;
  /** Raw schema body text, for malformed or externally-referencing schemas. */
  schemaRaw?: string | undefined;
  /** Extra Markdown appended before `Related topics`. */
  extra?: string | undefined;
}

function schemaBlock(spec: FixtureWorkflowSpec): string {
  const raw = spec.schemaRaw ?? (spec.schema === undefined ? undefined : JSON.stringify(spec.schema, null, 2));
  if (raw === undefined) return '## Input schema\n\nNo schema accordion is published for this workflow.\n\n';
  return `## Input schema\n\n<Accordion title="Complete JSON schema">\n  \`\`\`json\n${raw}\n  \`\`\`\n</Accordion>\n\n`;
}

function workflowPage(spec: FixtureWorkflowSpec): string {
  const endpointId = spec.endpointId === undefined ? spec.listedEndpoint : spec.endpointId;
  const endpointUrl =
    spec.endpointUrl === undefined
      ? spec.listedEndpoint === null
        ? null
        : `https://api.higgsfield.ai/${spec.listedEndpoint}`
      : spec.endpointUrl;
  const labels: string[] = [];
  if (endpointUrl !== null) labels.push(`**Endpoint:** \`POST ${endpointUrl}\``);
  if (endpointId !== null) labels.push(`**Endpoint ID:** \`${endpointId}\``);
  return [
    `# ${spec.title}`,
    '',
    '<div className="models-color-scope" aria-hidden="true" />',
    '',
    ...(labels.length === 0 ? [] : [labels.join('\n\n'), '']),
    '<a className="model-playground-card" href="https://console.higgsfield.ai/models/playground" target="_blank" rel="noreferrer">',
    '  <span className="model-playground-title">Open API Playground</span>',
    '</a>',
    '',
    '## Usage notes',
    '',
    '* Fixture page: media URLs must be publicly accessible before submitting.',
    '',
    '## Quick start',
    '',
    '```bash theme={"theme":{"light":"github-light","dark":"github-dark"}}',
    `curl --request POST --url ${endpointUrl ?? 'https://api.higgsfield.ai/undocumented'}`,
    '```',
    '',
    ...(spec.extra === undefined ? [] : [spec.extra, '']),
    schemaBlock(spec),
    '## Related topics',
    '',
    `- [${spec.familyTitle} API](/docs/models/${spec.family}.md)`,
    '- [Model API Reference](/docs/models.md)',
    '- [Unrelated upstream page](https://example.com/should-never-be-fetched)',
    '',
    'This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.'
  ].join('\n');
}

function familyPage(specs: readonly FixtureWorkflowSpec[], title: string): string {
  const rows = specs.map((spec) => {
    const endpointCell = spec.listedEndpoint === null ? '' : `\`POST /${spec.listedEndpoint}\``;
    return `| [${spec.label}](/docs/models/${spec.path}) | ${endpointCell} |`;
  });
  return [
    `# ${title}`,
    '',
    '<div className="models-color-scope" aria-hidden="true" />',
    '',
    '## Workflows',
    '',
    '| Workflow | Endpoint |',
    '| - | - |',
    ...rows,
    '',
    'Open a workflow to see its complete input schema, required fields, supported values and request examples.',
    '',
    '## Related topics',
    '',
    '- [Model API Reference](/docs/models.md)',
    '',
    'This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.'
  ].join('\n');
}

function categoryPage(specs: readonly FixtureWorkflowSpec[], title: string): string {
  const families = [...new Set(specs.map((spec) => `${spec.family}|${spec.familyTitle}`))];
  const cards = families.flatMap((entry) => {
    const [family, familyTitle] = entry.split('|') as [string, string];
    return [
      '  <a className="featured-model-card" href="/docs/models/' + family + '">',
      `    <span className="featured-model-title">${familyTitle}</span>`,
      '    <span className="featured-model-link">View API reference</span>',
      '  </a>'
    ];
  });
  return [
    `# ${title}`,
    '',
    '## Models',
    '',
    '<div className="featured-model-list">',
    ...cards,
    '</div>',
    '',
    '## Quick start',
    '',
    '1. Choose a model and the workflow that matches your inputs.',
    '',
    '## Related topics',
    '',
    '- [Model API Reference](/docs/models.md)',
    '- [Never followed](https://console.higgsfield.ai/explore)',
    '',
    'This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.'
  ].join('\n');
}

/**
 * The index advertises only the categories this fixture actually documents: the crawler
 * treats an advertised-but-empty category as a malformed directory, which is correct
 * behavior and must not be provoked accidentally by a narrow fixture.
 */
function indexPage(types: readonly ('image' | 'video')[]): string {
  const cards = (['video', 'image'] as const)
    .filter((type) => types.includes(type))
    .flatMap((type) => [
      `  <a className="model-category-card" href="/docs/models/${type}-generation">`,
      `    <span className="model-category-title">${type === 'video' ? 'Video' : 'Image'} Generation API</span>`,
      '  </a>'
    ]);
  return [
    '# Model API Reference',
    '',
    '> Choose a Higgsfield image or video model and open its API reference or Playground.',
    '',
    '<div className="models-color-scope" aria-hidden="true" />',
    '',
    'Use the Higgsfield API to generate images and videos with leading foundation models.',
    '',
    '## Choose a model category',
    '',
    '<div className="model-category-grid">',
    ...cards,
    '</div>',
    '',
    '## How the catalog works',
    '',
    'The sidebar is organized by output type and model family.',
    '',
    '## Availability',
    '',
    'Availability and access can change; check the [API Console](https://console.higgsfield.ai) for your account.',
    '',
    '## Related topics',
    '',
    '- [Unrelated upstream page](https://example.com/should-never-be-fetched)',
    '',
    'This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.'
  ].join('\n');
}

/** Manifest-derived workflows: every one of these is executable in the fixture. */
export function manifestWorkflows(manifest: readonly ModelDefinition[]): FixtureWorkflowSpec[] {
  const schemaOf = (id: string): Record<string, unknown> => {
    const found = manifest.find((model) => model.id === id);
    if (found?.inputSchema === undefined) throw new Error(`fixture manifest has no schema for ${id}`);
    return found.inputSchema;
  };
  return [
    {
      type: 'image',
      family: 'grok-image-2',
      familyTitle: 'Grok Image 2.0',
      label: 'Generate and edit',
      path: 'grok-image-2/generate-and-edit',
      listedEndpoint: 'xai/grok-imagine-image-2.0',
      title: 'Grok Image 2.0 — Generate and edit API',
      schema: schemaOf('xai/grok-imagine-image-2.0')
    },
    {
      type: 'image',
      family: 'qwen-image-3',
      familyTitle: 'Qwen Image 3',
      label: 'Edit images',
      path: 'qwen-image-3/edit',
      listedEndpoint: 'alibaba/qwen-image-3/edit',
      title: 'Qwen Image 3 — Edit images API',
      schema: schemaOf('alibaba/qwen-image-3/edit')
    },
    {
      type: 'image',
      family: 'soul-id',
      familyTitle: 'Soul ID',
      label: 'Create character',
      path: 'soul-id/create-character',
      listedEndpoint: 'v1/custom-references',
      // The live page labels only `Endpoint:`; identity comes from the execution manifest.
      endpointId: null,
      title: 'Soul ID — Create character API',
      schema: schemaOf('soul-id')
    },
    {
      type: 'video',
      family: 'kling-2-5-turbo',
      familyTitle: 'Kling 2.5 Turbo',
      label: 'Pro text to video',
      path: 'kling-2-5-turbo/pro-text-to-video',
      listedEndpoint: 'kling-video/v2.5-turbo/pro/text-to-video',
      title: 'Kling 2.5 Turbo — Pro · Text to video API',
      schema: schemaOf('kling-video/v2.5-turbo/pro/text-to-video')
    }
  ];
}

/** Workflows documented for fixture-only manifest entries (drift and preview origins). */
function fixtureEntryWorkflows(manifest: readonly ModelDefinition[]): FixtureWorkflowSpec[] {
  const specs: FixtureWorkflowSpec[] = [];
  const drift = manifest.find((model) => model.id === 'fixture/drift-model');
  if (drift?.inputSchema !== undefined) {
    specs.push({
      type: 'image',
      family: 'fixture-drift',
      familyTitle: 'Fixture Drift',
      label: 'Generate',
      path: 'fixture-drift/generate',
      listedEndpoint: drift.endpoint,
      title: 'Fixture Drift Model — Generate API',
      // The documented schema lost the manifest's `required`, so execution must not be claimed.
      schema: { type: 'object', properties: { prompt: { type: 'string' } } }
    });
  }
  const preview = manifest.find((model) => model.id === 'fixture/preview-model');
  if (preview?.inputSchema !== undefined) {
    specs.push({
      type: 'video',
      family: 'fixture-preview',
      familyTitle: 'Fixture Preview',
      label: 'Reference to video',
      path: 'fixture-preview/reference-to-video',
      listedEndpoint: preview.endpoint,
      endpointUrl: `https://preview.higgsfield.ai/${preview.endpoint}`,
      title: 'Fixture Preview Model — Reference to video API',
      schema: preview.inputSchema
    });
  }
  const noSchema = manifest.find((model) => model.id === 'fixture/no-schema');
  if (noSchema !== undefined) {
    specs.push({
      type: 'image',
      family: 'fixture-no-schema',
      familyTitle: 'Fixture No Schema',
      label: 'Generate',
      path: 'fixture-no-schema/generate',
      listedEndpoint: noSchema.endpoint,
      title: 'Fixture No Schema Model — Generate API'
      // No `schema`: the page publishes no accordion at all.
    });
  }
  return specs;
}

/** Documented workflows the gateway has no adapter for, plus two malformed shapes. */
function documentedOnlyWorkflows(): FixtureWorkflowSpec[] {
  return [
    {
      type: 'image',
      family: 'qwen-image-3',
      familyTitle: 'Qwen Image 3',
      label: 'Text to image',
      path: 'qwen-image-3/text-to-image',
      listedEndpoint: 'alibaba/qwen-image-3/text-to-image',
      title: 'Qwen Image 3 — Text to image API',
      schema: {
        type: 'object',
        required: ['prompt'],
        properties: { prompt: { type: 'string', minLength: 1 }, resolution: { enum: ['1k', '2k'] } }
      }
    },
    {
      type: 'image',
      family: 'soul-standard',
      familyTitle: 'SOUL',
      label: 'Text to image',
      path: 'soul-standard/generate',
      listedEndpoint: 'higgsfield-ai/soul/standard',
      title: 'SOUL — Text to image API',
      schemaRaw: JSON.stringify({
        $defs: { Style: { type: 'string', enum: ['standard', 'cinematic'] } },
        type: 'object',
        properties: { prompt: { type: 'string' }, style: { $ref: '#/$defs/Style' } }
      })
    },
    {
      // No endpoint cell and no page metadata: retained, non-executable, id is the URL.
      type: 'video',
      family: 'wan-2-6',
      familyTitle: 'Wan 2.6',
      label: 'Text to video',
      path: 'wan-2-6/text-to-video',
      listedEndpoint: null,
      title: 'Wan 2.6 — Text to video API',
      schema: { type: 'object', properties: { prompt: { type: 'string' } } }
    },
    {
      // The family table and the page disagree about the endpoint id.
      type: 'video',
      family: 'kling-o3',
      familyTitle: 'Kling O3',
      label: 'Image reference',
      path: 'kling-o3/image-reference',
      listedEndpoint: 'kling-video/o3/image-reference',
      endpointId: 'kling-video/o3/reference-image',
      title: 'Kling O3 — Image reference API',
      schema: { type: 'object', properties: { prompt: { type: 'string' } } }
    },
    {
      // The page publishes an external `$ref`, so its schema cannot be trusted.
      type: 'video',
      family: 'ltx-2-5',
      familyTitle: 'LTX-2.5',
      label: 'Fast text to video',
      path: 'ltx-2-5/fast-text-to-video',
      listedEndpoint: 'lightricks/ltx-2.5/fast/text-to-video',
      title: 'LTX-2.5 — Fast text to video API',
      schemaRaw: JSON.stringify({
        type: 'object',
        properties: { prompt: { type: 'string' }, preset: { $ref: 'https://example.com/schemas/preset.json' } }
      })
    },
    {
      // No schema accordion at all.
      type: 'video',
      family: 'pixverse-v6',
      familyTitle: 'PixVerse V6',
      label: 'Text to video',
      path: 'pixverse-v6/text-to-video',
      listedEndpoint: 'pixverse/v6/text-to-video',
      title: 'PixVerse V6 — Text to video API'
    }
  ];
}

export interface DocsFixtureRequest {
  url: string;
  headers: Record<string, string>;
}

export interface DocsFixture {
  /** Mutable page store keyed by URL pathname. */
  pages: Map<string, string>;
  /** Requests the crawler actually made, in order, with the headers it sent. */
  requests: DocsFixtureRequest[];
  /** Injected transport, in the shape of the global `fetch`. */
  fetch: HiggsfieldFetch;
  /** Adds a workflow to an existing family and returns its documentation URL. */
  addWorkflow(spec: FixtureWorkflowSpec): string;
  /** Redirects a documented path to another URL (validated again by the crawler). */
  addRedirect(from: string, to: string): void;
  /** Makes every documentation request fail as if the site were unreachable. */
  setOffline(offline: boolean): void;
}

const CRLF = /\r\n/g;

export interface DocsFixtureOptions {
  /** Explicit workflow list; defaults to the manifest-derived, documented-only and malformed shapes. */
  workflows?: readonly FixtureWorkflowSpec[] | undefined;
  /** Execution manifest the documented workflows are generated from. */
  manifest?: readonly ModelDefinition[] | undefined;
}

/**
 * Builds the fixture directory. By default it documents every `FIXTURE_MANIFEST` entry
 * plus a set of documented-only and malformed shapes; pass `workflows` for a narrower
 * fixture, or `manifest` to generate the documented pages for a different manifest.
 */
export function createDocsFixture(options: DocsFixtureOptions = {}): DocsFixture {
  const manifest = options.manifest ?? FIXTURE_MANIFEST;
  const specs = [
    ...(options.workflows ?? [
      ...manifestWorkflows(manifest),
      ...fixtureEntryWorkflows(manifest),
      ...documentedOnlyWorkflows()
    ])
  ];
  const pages = new Map<string, string>();
  const redirects = new Map<string, string>();
  const requests: DocsFixtureRequest[] = [];
  let offline = false;

  const writeCategories = (): void => {
    const types = [...new Set(specs.map((spec) => spec.type))];
    pages.set('/docs/models.md', indexPage(types));
    pages.set('/docs/models/image-generation.md', categoryPage(specs.filter((s) => s.type === 'image'), 'Image Generation API'));
    pages.set('/docs/models/video-generation.md', categoryPage(specs.filter((s) => s.type === 'video'), 'Video Generation API'));
  };

  const writeFamilies = (): void => {
    const families = new Map<string, FixtureWorkflowSpec[]>();
    for (const spec of specs) {
      const group = families.get(spec.family);
      if (group === undefined) families.set(spec.family, [spec]);
      else group.push(spec);
    }
    for (const [family, group] of families) {
      const first = group[0] as FixtureWorkflowSpec;
      pages.set(`/docs/models/${family}.md`, familyPage(group, `${first.familyTitle} API`));
    }
  };

  const writeWorkflow = (spec: FixtureWorkflowSpec): void => {
    pages.set(`/docs/models/${spec.path}.md`, workflowPage(spec));
  };

  writeCategories();
  writeFamilies();
  for (const spec of specs) writeWorkflow(spec);

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    const supplied = init?.headers as Record<string, string> | undefined;
    if (supplied !== undefined) for (const [key, value] of Object.entries(supplied)) headers[key.toLowerCase()] = value;
    requests.push({ url, headers });
    if (offline) throw new TypeError('fixture documentation site is unreachable');
    const path = new URL(url).pathname;
    const redirect = redirects.get(path);
    if (redirect !== undefined) {
      return new Response(null, { status: 302, headers: { location: redirect } });
    }
    const page = pages.get(path);
    if (page === undefined) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(page.replace(CRLF, '\n'), {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' }
    });
  }) as unknown as HiggsfieldFetch;

  return {
    pages,
    requests,
    fetch: fetchImpl,
    addWorkflow(spec: FixtureWorkflowSpec): string {
      specs.push(spec);
      writeCategories();
      writeFamilies();
      writeWorkflow(spec);
      return `${FIXTURE_DOCS_ORIGIN}/docs/models/${spec.path}.md`;
    },
    addRedirect(from: string, to: string): void {
      redirects.set(from, to);
    },
    setOffline(value: boolean): void {
      offline = value;
    }
  };
}

/** Plain page map, for harnesses that inject the directory into another process. */
export function docsFixturePages(options: DocsFixtureOptions = {}): Record<string, string> {
  return Object.fromEntries(createDocsFixture(options).pages);
}
