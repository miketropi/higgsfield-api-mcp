/**
 * Frozen gateway configuration shape.
 *
 * Owned by the integration lead. Precedence is
 *   CLI arguments > environment > optional JSON config file > defaults
 * and every key below is validated at startup (fail fast).
 *
 * Array-valued keys are comma-separated in the environment and JSON arrays in a
 * config file. Sizes/durations are bytes and milliseconds respectively.
 */

export type TransportMode = 'stdio' | 'http';
export type AssetMode = 'passthrough' | 'managed';
export type AuthMode = 'none' | 'static_token' | 'oauth_jwt';

export interface RateLimitRuleConfig {
  limit: number;
  windowMs: number;
}

/** `HF_MCP_RATE_LIMITS_FILE` — JSON file. */
export interface RateLimitsFile {
  /** Admission cap applied to every request (plan default: 120/min per tenant+token). */
  global?: RateLimitRuleConfig | undefined;
  tenant?: { default?: RateLimitRuleConfig | undefined; byId?: Record<string, RateLimitRuleConfig> | undefined } | undefined;
  token?: { default?: RateLimitRuleConfig | undefined; byId?: Record<string, RateLimitRuleConfig> | undefined } | undefined;
  tool?: { byName?: Record<string, RateLimitRuleConfig> | undefined } | undefined;
  provider?: { default?: RateLimitRuleConfig | undefined } | undefined;
}

/** `HF_MCP_MODEL_ALIASES_FILE` — JSON file. */
export interface ModelAliasesFile {
  aliases: Record<string, string>;
  pricing?: Record<string, { unitMicroUsd?: number; perSecondMicroUsd?: number; source?: string; asOf?: string }> | undefined;
}

/** `HF_MCP_TENANTS_FILE` — JSON file. */
export interface TenantRecord {
  tenantId: string;
  tokenId: string;
  /**
   * SHA-256 hex digest of the provisioned bearer token. Exactly one of
   * `tokenSha256` / `oauthSubject` is present: static-token tenants carry the
   * digest, OAuth-JWT tenants carry the subject mapping.
   */
  tokenSha256?: string | undefined;
  expiresAt: string;
  audience: string;
  scopes: string[];
  /** Environment variable holding the provider credential string. */
  providerCredentialsEnv: string;
  /** Stable upstream account binding; shared across key rotations. */
  providerAccountId: string;
  /** OAuth subject binding. Mutually exclusive with `tokenSha256`. */
  oauthSubject?: string | undefined;
}

export interface TenantsFile {
  tenants: TenantRecord[];
}

export interface ProviderConfig {
  /** `HF_API_CREDENTIALS`, formatted `Key <id>:<secret>`. */
  credentials?: string | undefined;
  /** `HF_MCP_PROVIDER_ACCOUNT_ID`; derived from the credential id in local mode. */
  accountId?: string | undefined;
  baseUrl: string;
  requestTimeoutMs: number;
  uploadTimeoutMs: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  /** `HF_MCP_PUBLIC_URL` — gateway origin used for callback URLs and audience checks. */
  publicUrl?: string | undefined;
  allowedHosts: string[];
  allowedOrigins: string[];
  bodyLimitBytes: number;
  shutdownGraceMs: number;
}

export interface AuthConfig {
  mode: AuthMode;
  tenantsFile?: string | undefined;
  metricsToken?: string | undefined;
  oauth?: { issuer: string; jwksUrl: string; audience: string } | undefined;
}

export interface MediaConfig {
  allowedPaths: string[];
  assetMode: AssetMode;
  maxUploadBytes: number;
  downloadTimeoutMs: number;
  maxRedirects: number;
  signedUrlTtlSeconds: number;
}

export interface StorageConfig {
  endpoint?: string | undefined;
  region: string;
  bucket?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  forcePathStyle: boolean;
  prefix: string;
}

export interface PersistenceConfig {
  databaseUrl?: string | undefined;
  redisUrl?: string | undefined;
  requireDatabase: boolean;
  requireRedis: boolean;
}

export interface LimitsConfig {
  maxImageJobs: number;
  maxVideoJobs: number;
  rateLimitsFile?: string | undefined;
}

export interface ModelConfig {
  /** `HF_MCP_MODEL_ALIASES_FILE` — JSON file with semantic aliases and price overrides. */
  aliasesFile?: string | undefined;
}

export interface CostConfig {
  maxJobCostUsd?: number | undefined;
  dailyCostLimitUsd?: number | undefined;
  requireConfirmAboveUsd?: number | undefined;
}

export interface ObservabilityConfig {
  level: string;
  pretty: boolean;
  metricsEnabled: boolean;
  otlpEndpoint?: string | undefined;
  serviceName: string;
}

export interface FeatureFlags {
  agentApi: boolean;
  dynamicModels: boolean;
  webhooks: boolean;
}

export interface WorkerConfig {
  enabled: boolean;
  pollIntervalFloorMs: number;
  pollIntervalCeilingMs: number;
  transientBackoffMs: number;
  replayBackoffMinMs: number;
  replayBackoffMaxMs: number;
}

export interface GatewayConfig {
  transport: TransportMode;
  /** Local mode is stdio with no external services; remote mode requires Postgres + Redis. */
  mode: 'local' | 'remote';
  server: ServerConfig;
  auth: AuthConfig;
  provider: ProviderConfig;
  media: MediaConfig;
  storage: StorageConfig;
  persistence: PersistenceConfig;
  limits: LimitsConfig;
  models: ModelConfig;
  cost: CostConfig;
  observability: ObservabilityConfig;
  features: FeatureFlags;
  workers: WorkerConfig;
  /** Base64 32-byte key: `HF_MCP_DATA_ENCRYPTION_KEY`. */
  dataEncryptionKey?: string | undefined;
  /** Directory holding generated skills; resolved to the packaged asset when unset. */
  skillsDir?: string | undefined;
  configFile?: string | undefined;
}
