/**
 * `@higgsfield-mcp/config` — startup configuration for the Higgsfield MCP
 * gateway.
 *
 * Precedence: explicit `overrides` > parsed CLI flags > environment > JSON
 * config file > `CONFIG_DEFAULTS`. The merged result is Zod-validated as a
 * whole, so a broken configuration fails fast with every problem listed.
 */
export { ConfigValidationError } from './errors.js';
export type { ConfigIssue } from './errors.js';

export { ASSET_MODES, AUTH_MODES, CONFIG_DEFAULTS, LOG_LEVELS, TRANSPORT_MODES } from './defaults.js';
export type { LogLevel } from './defaults.js';

export { ENV_KEY_SPECS, ENV_SPECS } from './env.js';
export type { EnvSpec } from './env.js';

export { CLI_FLAG_NAMES, parseGlobalFlags } from './cli.js';
export type { CliOverrides, ParsedGlobalFlags } from './cli.js';

export { loadConfig } from './load.js';
export type { LoadConfigInput } from './load.js';

export { loadConfigFile, loadModelAliasesFile, loadRateLimitsFile, loadTenantsFile } from './files.js';

export type {
  AssetMode,
  AuthConfig,
  AuthMode,
  CostConfig,
  FeatureFlags,
  GatewayConfig,
  LimitsConfig,
  MediaConfig,
  ModelAliasesFile,
  ModelConfig,
  ObservabilityConfig,
  PersistenceConfig,
  ProviderConfig,
  RateLimitRuleConfig,
  RateLimitsFile,
  ServerConfig,
  StorageConfig,
  TenantRecord,
  TenantsFile,
  TransportMode,
  WorkerConfig
} from './types.js';
