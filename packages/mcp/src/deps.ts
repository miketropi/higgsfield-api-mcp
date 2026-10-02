import type {
  Admission,
  GenerationService,
  JobService,
  LoggerPort,
  MediaService,
  MetricsPort,
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
  auth: { mode: 'none' | 'static_token' | 'oauth_jwt'; scopes: string[] };
  limits: { maxWaitMs: number; maxImageJobs: number; maxVideoJobs: number };
}

export interface McpToolDependencies {
  generation: GenerationService;
  jobs: JobService;
  media: MediaService;
  models: ModelRegistry;
  capabilities: GatewayCapabilitiesInfo;
  /** Tenant/token/tool admission limits (SPEC §38). */
  admission: Admission;
  logger: LoggerPort;
  metrics: MetricsPort;
}
