import type { GenerationResult, LoggerPort, RequestContext, StructuredError } from '@higgsfield-mcp/core';
import { GatewayError, toStructuredError } from '@higgsfield-mcp/core';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AdmissionClass } from '@higgsfield-mcp/core';
import type { GatewayCapabilitiesInfo, McpToolDependencies } from './deps.js';
import {
  animateImageInput,
  editImageInput,
  generateImageInput,
  generateInput,
  generateVideoInput,
  jobsGetInput,
  jobsListInput,
  jobsWaitInput,
  mediaGetInput,
  mediaUploadInput,
  modelsGetInput,
  modelsListInput,
  RESOURCE_URIS,
  requireScope,
  SCOPES,
  toCoreInput
} from './schemas.js';
import type { GenerateArgs, GenerateImageArgs, MediaUploadArgs } from './schemas.js';
import {
  assetSchema,
  capabilitiesSchema,
  confirmationSchema,
  discoveredCatalogSchema,
  discoveredModelResultSchema,
  errorEnvelope,
  jobSchema,
  jsonText,
  serializeAsset,
  serializeCatalog,
  serializeDiscoveredResult,
  serializeDiscoveredSummary,
  serializeJob
} from './serialize.js';
import type { WireCatalog, WireCapabilities } from './serialize.js';

const DEFAULT_WAIT_MS = 20_000;

/**
 * Appended to every billable generation tool description. Agents read these strings
 * verbatim, so the guidance has to live here: without it a caller can invent a paid
 * subject the user never asked for and submit it in one step.
 */
const BILLABLE_BRIEFING =
  'This tool creates or edits media and the request is billable, so only call it when the user asked for generation ' +
  'or editing. The prompt is the user\'s brief: elaborate a subject the user authorised, never invent one to turn ' +
  'model discovery into spending — ask for a brief instead. Report the returned cost; a returned job cost is the ' +
  'provider\'s reported figure, not invoice proof. A cost estimate can be unavailable, and configured spend limits ' +
  'can reject the request outright. Only an amount above the configured confirmation threshold returns status ' +
  '"confirmation_required" with a confirmation_token; a token records that a caller acknowledged the amount and does ' +
  'not prove a human approved it, so obtain the user\'s approval before resubmitting the same request with that token.';

/**
 * Admission class per non-generation tool. Generation tools are deliberately absent:
 * `GenerationService` admits them with the model-derived class, so a native
 * `higgsfield.generate` call cannot bypass the video ceiling.
 */
const ADMISSION_CLASS_BY_TOOL: Readonly<Record<string, AdmissionClass | undefined>> = {
  'higgsfield.media.upload': 'upload',
  'higgsfield.media.get': 'read',
  'higgsfield.models.list': 'read',
  'higgsfield.models.get': 'read',
  'higgsfield.capabilities': 'read',
  'higgsfield.jobs.get': 'read',
  'higgsfield.jobs.wait': 'read',
  'higgsfield.jobs.cancel': 'read',
  'higgsfield.jobs.list': 'read'
};
const jobListSchema = z.object({ jobs: z.array(jobSchema), next_cursor: z.string().optional() });
const generationResultSchema = z.union([jobSchema, confirmationSchema]);

export function serializeCapabilities(capabilities: GatewayCapabilitiesInfo): WireCapabilities {
  return {
    gateway_version: capabilities.gatewayVersion,
    mcp_protocol: capabilities.mcpProtocol,
    provider: { id: capabilities.provider.id, version: capabilities.provider.version },
    skills_version: capabilities.skillsVersion,
    capabilities: capabilities.capabilities,
    // Derived, never stored: the published count cannot drift from the names.
    tools: { count: capabilities.tools.names.length, names: capabilities.tools.names },
    auth: { mode: capabilities.auth.mode, scopes: capabilities.auth.scopes },
    limits: {
      max_wait_ms: capabilities.limits.maxWaitMs,
      max_image_jobs: capabilities.limits.maxImageJobs,
      max_video_jobs: capabilities.limits.maxVideoJobs
    }
  };
}

/**
 * Builds one MCP server instance for a single request/connection. Tools stay thin:
 * parse → validate → call a core service → serialize. No provider or transport logic.
 */
export function createGatewayMcpServer(deps: McpToolDependencies, context: RequestContext): McpServer {
  const server = new McpServer({ name: 'higgsfield-mcp', version: deps.capabilities.gatewayVersion });
  const logger: LoggerPort = deps.logger;

  const finish = (tool: string, schema: z.ZodType | undefined, structured: Record<string, unknown>): CallToolResult => {
    if (schema !== undefined) {
      const parsed = schema.safeParse(structured);
      if (!parsed.success) {
        logger.error(
          { event: 'mcp.output_invalid', tool, issue: parsed.error.issues[0]?.path.join('.') ?? '(root)' },
          'Serialized tool output did not match the advertised schema'
        );
        const envelope = errorEnvelope(
          new GatewayError('INTERNAL_ERROR', 'The gateway produced an invalid response for this tool.')
        );
        return { content: [{ type: 'text', text: jsonText(envelope) }], isError: true };
      }
    }
    return {
      content: [{ type: 'text', text: jsonText(structured) }],
      structuredContent: structured
    };
  };

  const wrap = async (
    name: string,
    schema: z.ZodType | undefined,
    handler: () => Promise<Record<string, unknown>>
  ): Promise<CallToolResult> => {
    deps.metrics.toolCall(name, context.transport);
    try {
      // Generation admission happens inside GenerationService, where the resolved
      // capability is known; uploads and read-style tools are admitted here.
      const admitClass: AdmissionClass | undefined = ADMISSION_CLASS_BY_TOOL[name];
      if (admitClass !== undefined) {
        await deps.admission.admit({ tool: name, class: admitClass, context });
      }
      return finish(name, schema, await handler());
    } catch (error) {
      const structured: StructuredError = toStructuredError(error);
      deps.metrics.toolError(name, structured.code);
      logger.warn(
        { event: 'mcp.tool_error', tool: name, code: structured.code, request_id: context.requestId },
        'Tool call failed'
      );
      return { content: [{ type: 'text', text: jsonText(errorEnvelope(error)) }], isError: true };
    }
  };

  const signalFrom = (ctx: unknown): AbortSignal | undefined => {
    const candidate = ctx as { mcpReq?: { signal?: AbortSignal } } | undefined;
    return candidate?.mcpReq?.signal;
  };

  const submitSemantic = async (params: {
    toolName: string;
    endpoint: string;
    input: Record<string, unknown>;
    wait?: boolean | undefined;
    idempotencyKey?: string | undefined;
    workspaceId?: string | undefined;
    confirmationToken?: string | undefined;
    signal?: AbortSignal | undefined;
    webhook?: { url: string } | undefined;
  }): Promise<Record<string, unknown>> => {
    requireScope(context, SCOPES.generate);
    const request = {
      endpoint: params.endpoint,
      input: toCoreInput(params.input) as Record<string, unknown>,
      ...(params.idempotencyKey === undefined ? {} : { idempotencyKey: params.idempotencyKey }),
      ...(params.workspaceId === undefined ? {} : { workspaceId: params.workspaceId }),
      ...(params.wait === undefined ? {} : { wait: params.wait }),
      ...(params.confirmationToken === undefined ? {} : { confirmationToken: params.confirmationToken }),
      ...(params.signal === undefined ? {} : { signal: params.signal }),
      ...(params.webhook === undefined ? {} : { webhook: params.webhook })
    };
    const result: GenerationResult = await deps.generation.submit(params.toolName, request, context);
    if (result.status === 'confirmation_required') {
      return {
        status: 'confirmation_required',
        estimated_cost_usd: result.estimatedCostUsd,
        confirmation_token: result.confirmationToken,
        expires_at: result.expiresAt
      };
    }
    return serializeJob(result) as unknown as Record<string, unknown>;
  };

  const semanticArgs = (args: Record<string, unknown>): {
    input: Record<string, unknown>;
    wait?: boolean;
    idempotencyKey?: string;
    workspaceId?: string;
    confirmationToken?: string;
  } => {
    const { wait, idempotency_key, workspace_id, confirmation_token, ...input } = args;
    return {
      input,
      ...(wait === undefined ? {} : { wait: wait as boolean }),
      ...(idempotency_key === undefined ? {} : { idempotencyKey: idempotency_key as string }),
      ...(workspace_id === undefined ? {} : { workspaceId: workspace_id as string }),
      ...(confirmation_token === undefined ? {} : { confirmationToken: confirmation_token as string })
    };
  };

  server.registerTool(
    'higgsfield.generate_image',
    {
      title: 'Generate image',
      description:
        'Generate an image from a prompt, optionally with reference images. Returns a job object immediately unless wait=true. ' +
        BILLABLE_BRIEFING,
      inputSchema: generateImageInput,
      outputSchema: generationResultSchema
    },
    async (args: GenerateImageArgs, ctx) =>
      wrap('higgsfield.generate_image', generationResultSchema, async () =>
        submitSemantic({
          toolName: 'higgsfield.generate_image',
          endpoint: 'image.default',
          signal: signalFrom(ctx),
          ...semanticArgs(args as unknown as Record<string, unknown>)
        })
      )
  );

  server.registerTool(
    'higgsfield.edit_image',
    {
      title: 'Edit image',
      description:
        'Edit or restyle an existing image using a prompt and up to three ordered references. ' +
        BILLABLE_BRIEFING,
      inputSchema: editImageInput,
      outputSchema: generationResultSchema
    },
    async (args, ctx) =>
      wrap('higgsfield.edit_image', generationResultSchema, async () =>
        submitSemantic({
          toolName: 'higgsfield.edit_image',
          endpoint: 'image.edit',
          signal: signalFrom(ctx),
          ...semanticArgs(args as unknown as Record<string, unknown>)
        })
      )
  );

  server.registerTool(
    'higgsfield.generate_video',
    {
      title: 'Generate video',
      description:
        'Generate a video from a prompt, optionally with a start frame, end frame or references. The gateway selects the documented endpoint that supports the inputs you send. ' +
        BILLABLE_BRIEFING,
      inputSchema: generateVideoInput,
      outputSchema: generationResultSchema
    },
    async (args, ctx) =>
      wrap('higgsfield.generate_video', generationResultSchema, async () =>
        submitSemantic({
          toolName: 'higgsfield.generate_video',
          endpoint: 'video.default',
          signal: signalFrom(ctx),
          ...semanticArgs(args as unknown as Record<string, unknown>)
        })
      )
  );

  server.registerTool(
    'higgsfield.animate_image',
    {
      title: 'Animate image',
      description: 'Animate a still image into a short video (image-to-video). ' + BILLABLE_BRIEFING,
      inputSchema: animateImageInput,
      outputSchema: generationResultSchema
    },
    async (args, ctx) =>
      wrap('higgsfield.animate_image', generationResultSchema, async () =>
        submitSemantic({
          toolName: 'higgsfield.animate_image',
          endpoint: 'video.image_to_video',
          signal: signalFrom(ctx),
          ...semanticArgs(args as unknown as Record<string, unknown>)
        })
      )
  );

  server.registerTool(
    'higgsfield.generate',
    {
      title: 'Provider-native generation',
      description:
        'Submit a request to a registered provider endpoint with provider-native fields. The endpoint must appear in ' +
        'higgsfield.models.get with execution.supported true: a workflow that is merely documented is not runnable ' +
        'here, and listing models never authorizes an arbitrary endpoint. The gateway re-checks the endpoint against ' +
        'its own allowlist before any provider call and refuses anything else. ' +
        BILLABLE_BRIEFING,
      inputSchema: generateInput,
      outputSchema: generationResultSchema
    },
    async (args: GenerateArgs, ctx) =>
      wrap('higgsfield.generate', generationResultSchema, async () =>
        submitSemantic({
          toolName: 'higgsfield.generate',
          endpoint: args.endpoint,
          input: args.input,
          signal: signalFrom(ctx),
          ...(args.webhook === undefined ? {} : { webhook: args.webhook }),
          ...(args.wait === undefined ? {} : { wait: args.wait }),
          ...(args.idempotency_key === undefined ? {} : { idempotencyKey: args.idempotency_key }),
          ...(args.workspace_id === undefined ? {} : { workspaceId: args.workspace_id }),
          ...(args.confirmation_token === undefined ? {} : { confirmationToken: args.confirmation_token })
        })
      )
  );

  server.registerTool(
    'higgsfield.media.upload',
    {
      title: 'Upload media',
      description:
        'Upload a local file (stdio only) or a public HTTPS URL and return an asset reference usable by generation tools.',
      inputSchema: mediaUploadInput,
      outputSchema: assetSchema
    },
    async (args: MediaUploadArgs) =>
      wrap('higgsfield.media.upload', assetSchema, async () => {
        requireScope(context, SCOPES.upload);
        const asset = await deps.media.upload(
          {
            source: 'path' in args.source ? { path: args.source.path } : { url: args.source.url },
            ...(args.media_type === undefined ? {} : { mediaType: args.media_type })
          },
          context
        );
        return serializeAsset(asset) as unknown as Record<string, unknown>;
      })
  );

  server.registerTool(
    'higgsfield.media.get',
    {
      title: 'Get media asset',
      description: 'Return metadata for an asset owned by the calling tenant, including a fresh signed URL when managed.',
      inputSchema: mediaGetInput,
      outputSchema: assetSchema
    },
    async (args: z.infer<typeof mediaGetInput>) =>
      wrap('higgsfield.media.get', assetSchema, async () => {
        requireScope(context, SCOPES.read);
        const asset = await deps.media.get(args.asset_id, context);
        return serializeAsset(asset) as unknown as Record<string, unknown>;
      })
  );

  server.registerTool(
    'higgsfield.models.list',
    {
      title: 'List models',
      description:
        'Read-only. List the workflows the provider documents today, optionally filtered by media type, capability or ' +
        'execution support. Each entry reports its documentation provenance, whether a schema was readable, and ' +
        'execution.supported — true only when this gateway can run that endpoint as documented. Discovering or ' +
        'comparing models never generates anything and never spends money: do not submit a sample generation to ' +
        'inspect a model.',
      inputSchema: modelsListInput,
      outputSchema: discoveredCatalogSchema
    },
    async (args: z.infer<typeof modelsListInput>) =>
      wrap('higgsfield.models.list', discoveredCatalogSchema, async () => {
        requireScope(context, SCOPES.read);
        const filter = {
          ...(args.type === undefined ? {} : { type: args.type }),
          ...(args.capability === undefined ? {} : { capability: args.capability }),
          ...(args.execution_supported === undefined ? {} : { executionSupported: args.execution_supported })
        };
        const catalog = await deps.discovery.list(filter);
        const structured: { models: unknown[]; catalog: WireCatalog } = {
          models: catalog.models.map(serializeDiscoveredSummary),
          catalog: serializeCatalog(catalog.catalog)
        };
        return structured as unknown as Record<string, unknown>;
      })
  );

  server.registerTool(
    'higgsfield.models.get',
    {
      title: 'Get model',
      description:
        'Read-only. Return one documented model: its endpoint, the documented input schema when it could be read, its ' +
        'execution support verdict and the documentation URL it came from. Reading a model never generates anything ' +
        'and never spends money.',
      inputSchema: modelsGetInput,
      outputSchema: discoveredModelResultSchema
    },
    async (args: z.infer<typeof modelsGetInput>) =>
      wrap('higgsfield.models.get', discoveredModelResultSchema, async () => {
        requireScope(context, SCOPES.read);
        return serializeDiscoveredResult(await deps.discovery.get(args.model)) as unknown as Record<string, unknown>;
      })
  );

  server.registerTool(
    'higgsfield.capabilities',
    {
      title: 'Gateway capabilities',
      description: 'Inspect this gateway: versions, supported capabilities, authentication mode and limits.',
      inputSchema: z.object({}).strict(),
      outputSchema: capabilitiesSchema
    },
    async () =>
      wrap('higgsfield.capabilities', capabilitiesSchema, async () => {
        requireScope(context, SCOPES.read);
        return serializeCapabilities(deps.capabilities) as unknown as Record<string, unknown>;
      })
  );

  server.registerTool(
    'higgsfield.jobs.get',
    {
      title: 'Get job',
      description: 'Return the current state of a generation job.',
      inputSchema: jobsGetInput,
      outputSchema: jobSchema
    },
    async (args: z.infer<typeof jobsGetInput>) =>
      wrap('higgsfield.jobs.get', jobSchema, async () => {
        requireScope(context, SCOPES.read);
        return serializeJob(await deps.jobs.get(args.job_id, context)) as unknown as Record<string, unknown>;
      })
  );

  server.registerTool(
    'higgsfield.jobs.wait',
    {
      title: 'Wait for job',
      description:
        'Wait for a job to reach a terminal state, bounded by the gateway maximum. A timeout returns the still-running job without cancelling it.',
      inputSchema: jobsWaitInput,
      outputSchema: jobSchema
    },
    async (args: z.infer<typeof jobsWaitInput>) =>
      wrap('higgsfield.jobs.wait', jobSchema, async () => {
        requireScope(context, SCOPES.read);
        const requested = args.timeout_ms ?? DEFAULT_WAIT_MS;
        const bounded = Math.min(requested, deps.capabilities.limits.maxWaitMs);
        const job = await deps.jobs.wait(args.job_id, bounded, context);
        return serializeJob(job) as unknown as Record<string, unknown>;
      })
  );

  server.registerTool(
    'higgsfield.jobs.cancel',
    {
      title: 'Cancel job',
      description:
        'Cancel a job that has not been accepted by the provider yet. A job whose processing already started is returned unchanged with a rejection reason.',
      inputSchema: jobsGetInput,
      outputSchema: jobSchema
    },
    async (args: z.infer<typeof jobsGetInput>) =>
      wrap('higgsfield.jobs.cancel', jobSchema, async () => {
        requireScope(context, SCOPES.generate);
        return serializeJob(await deps.jobs.cancel(args.job_id, context)) as unknown as Record<string, unknown>;
      })
  );

  server.registerTool(
    'higgsfield.jobs.list',
    {
      title: 'List jobs',
      description: 'List recent jobs for the calling tenant, newest first.',
      inputSchema: jobsListInput,
      outputSchema: jobListSchema
    },
    async (args: z.infer<typeof jobsListInput>) =>
      wrap('higgsfield.jobs.list', jobListSchema, async () => {
        requireScope(context, SCOPES.read);
        const result = await deps.jobs.list(context, args.cursor);
        const structured: Record<string, unknown> = { jobs: result.jobs.map(serializeJob) };
        const cursor = result.nextCursor ?? result.next_cursor;
        if (cursor !== undefined) structured['next_cursor'] = cursor;
        return structured;
      })
  );

  const resourceContents = (
    uri: URL,
    schema: z.ZodType,
    structured: Record<string, unknown>
  ): { contents: { uri: string; mimeType: string; text: string }[] } => {
    if (!schema.safeParse(structured).success) {
      throw new GatewayError('INTERNAL_ERROR', 'The gateway produced an invalid resource body.');
    }
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: jsonText(structured) }] };
  };

  server.registerResource(
    'capabilities',
    RESOURCE_URIS.capabilities,
    { title: 'Gateway capabilities', mimeType: 'application/json', cacheHint: { ttlMs: 60_000, cacheScope: 'public' } },
    async (uri) => {
      requireScope(context, SCOPES.read);
      return resourceContents(uri, capabilitiesSchema, serializeCapabilities(deps.capabilities) as unknown as Record<string, unknown>);
    }
  );

  server.registerResource(
    'models',
    RESOURCE_URIS.models,
    { title: 'Documented models', mimeType: 'application/json', cacheHint: { ttlMs: 60_000, cacheScope: 'public' } },
    async (uri) => {
      requireScope(context, SCOPES.read);
      const catalog = await deps.discovery.list();
      const structured = {
        models: catalog.models.map(serializeDiscoveredSummary),
        catalog: serializeCatalog(catalog.catalog)
      };
      return resourceContents(uri, discoveredCatalogSchema, structured as unknown as Record<string, unknown>);
    }
  );

  server.registerResource(
    'model',
    new ResourceTemplate(RESOURCE_URIS.modelTemplate, { list: undefined }),
    { title: 'Documented model', mimeType: 'application/json', cacheHint: { ttlMs: 60_000, cacheScope: 'public' } },
    async (uri, variables) => {
      requireScope(context, SCOPES.read);
      const id = decodeURIComponent(String(variables['id']));
      const result = await deps.discovery.get(id);
      return resourceContents(uri, discoveredModelResultSchema, serializeDiscoveredResult(result) as unknown as Record<string, unknown>);
    }
  );

  server.registerResource(
    'job',
    new ResourceTemplate(RESOURCE_URIS.jobTemplate, { list: undefined }),
    { title: 'Generation job', mimeType: 'application/json', cacheHint: { ttlMs: 0, cacheScope: 'private' } },
    async (uri, variables) => {
      requireScope(context, SCOPES.read);
      const id = decodeURIComponent(String(variables['id']));
      const job = await deps.jobs.get(id, context);
      return resourceContents(uri, jobSchema, serializeJob(job) as unknown as Record<string, unknown>);
    }
  );

  server.registerResource(
    'asset',
    new ResourceTemplate(RESOURCE_URIS.assetTemplate, { list: undefined }),
    { title: 'Media asset', mimeType: 'application/json', cacheHint: { ttlMs: 0, cacheScope: 'private' } },
    async (uri, variables) => {
      requireScope(context, SCOPES.read);
      const id = decodeURIComponent(String(variables['id']));
      const asset = await deps.media.get(id, context);
      return resourceContents(uri, assetSchema, serializeAsset(asset) as unknown as Record<string, unknown>);
    }
  );

  return server;
}
