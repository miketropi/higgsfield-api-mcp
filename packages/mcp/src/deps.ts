import type {
  Admission,
  GenerationService,
  JobService,
  LoggerPort,
  MediaService,
  MetricsPort,
  ModelDiscovery,
  ModelRegistry
} from '@higgsfield-mcp/core';

/** Published gateway identity and honest capability list (SPEC §58). */
export interface GatewayCapabilitiesInfo {
  gatewayVersion: string;
  mcpProtocol: string;
  provider: { id: string; version: string };
  skillsVersion: string;
  /** Only capabilities the registry and provider adapter actually support. */
  capabilities: string[];
  /**
   * The MCP tool surface this build registers. `count` is derived from these names
   * at serialization time, so the published count can never drift from the surface.
   */
  tools: { names: string[] };
  auth: { mode: 'none' | 'static_token' | 'oauth_jwt'; scopes: string[] };
  limits: { maxWaitMs: number; maxImageJobs: number; maxVideoJobs: number };
}

export interface McpToolDependencies {
  generation: GenerationService;
  jobs: JobService;
  media: MediaService;
  /**
   * Execution manifest: routing, validation, provider defaults and the endpoint
   * allowlist. This is the only thing that authorizes a provider call.
   */
  models: ModelRegistry;
  /** Live documentation discovery. Read-only, and never an execution grant. */
  discovery: ModelDiscovery;
  capabilities: GatewayCapabilitiesInfo;
  /** Tenant/token/tool admission limits (SPEC §38). */
  admission: Admission;
  logger: LoggerPort;
  metrics: MetricsPort;
}
