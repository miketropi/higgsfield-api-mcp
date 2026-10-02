import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigValidationError, formatIssuePath, type ConfigIssue } from './errors.js';
import { AUTH_MODES, LOG_LEVELS, ASSET_MODES, TRANSPORT_MODES } from './defaults.js';
import { ENV_VAR_NAME, HTTPS_URL, HTTP_URL, MAX_ENV_VAR_NAME, NON_EMPTY, NON_NEGATIVE_INT, POSITIVE_INT, SHA256_HEX } from './schema.js';
import type { ModelAliasesFile, RateLimitsFile, TenantRecord, TenantsFile } from './types.js';

/**
 * Fields whose value *is* a secret. A config file may reference environment
 * variable names, never carry credential material itself, so these keys are
 * present-but-always-failing rather than simply unknown: the error tells the
 * operator what to do instead of "unrecognized key".
 */
const secretInFile = (path: string) =>
  z.unknown().refine(() => false, `${path} is a secret: provide it through an environment variable, not a config file`);

/**
 * Shape of the optional JSON config file (`--config <path>`). Keys mirror
 * `GatewayConfig` and every object is strict: a typo is a startup failure, not
 * a silently ignored setting.
 */
export const configFileSchema = z.strictObject({
  transport: z.enum(TRANSPORT_MODES).optional(),
  server: z
    .strictObject({
      host: NON_EMPTY.optional(),
      port: z.number().int().min(1).max(65_535).optional(),
      publicUrl: HTTP_URL.optional(),
      allowedHosts: z.array(NON_EMPTY).optional(),
      allowedOrigins: z.array(NON_EMPTY).optional(),
      bodyLimitBytes: POSITIVE_INT.optional(),
      shutdownGraceMs: NON_NEGATIVE_INT.optional()
    })
    .optional(),
  auth: z
    .strictObject({
      mode: z.enum(AUTH_MODES).optional(),
      tenantsFile: NON_EMPTY.optional(),
      metricsToken: secretInFile('auth.metricsToken').optional(),
      oauth: z
        .strictObject({ issuer: HTTPS_URL, jwksUrl: HTTPS_URL, audience: NON_EMPTY })
        .optional()
    })
    .optional(),
  provider: z
    .strictObject({
      accountId: NON_EMPTY.optional(),
      credentials: secretInFile('provider.credentials').optional(),
      baseUrl: HTTP_URL.optional(),
      requestTimeoutMs: POSITIVE_INT.optional(),
      uploadTimeoutMs: POSITIVE_INT.optional()
    })
    .optional(),
  media: z
    .strictObject({
      allowedPaths: z.array(NON_EMPTY).optional(),
      assetMode: z.enum(ASSET_MODES).optional(),
      maxUploadBytes: POSITIVE_INT.optional(),
      downloadTimeoutMs: POSITIVE_INT.optional(),
      maxRedirects: z.number().int().min(0).max(10).optional(),
      signedUrlTtlSeconds: z.number().int().min(1).max(604_800).optional()
    })
    .optional(),
  storage: z
    .strictObject({
      endpoint: NON_EMPTY.optional(),
      region: NON_EMPTY.optional(),
      bucket: NON_EMPTY.optional(),
      accessKeyId: secretInFile('storage.accessKeyId').optional(),
      secretAccessKey: secretInFile('storage.secretAccessKey').optional(),
      forcePathStyle: z.boolean().optional(),
      prefix: z.string().optional()
    })
    .optional(),
  persistence: z
    .strictObject({
      databaseUrl: secretInFile('persistence.databaseUrl').optional(),
      redisUrl: secretInFile('persistence.redisUrl').optional()
    })
    .optional(),
  limits: z
    .strictObject({
      maxImageJobs: POSITIVE_INT.optional(),
      maxVideoJobs: POSITIVE_INT.optional(),
      rateLimitsFile: NON_EMPTY.optional()
    })
    .optional(),
  models: z
    .strictObject({
      aliasesFile: NON_EMPTY.optional()
    })
    .optional(),
  cost: z
    .strictObject({
      maxJobCostUsd: z.number().min(0).optional(),
      dailyCostLimitUsd: z.number().min(0).optional(),
      requireConfirmAboveUsd: z.number().min(0).optional()
    })
    .optional(),
  observability: z
    .strictObject({
      level: z.enum(LOG_LEVELS).optional(),
      pretty: z.boolean().optional(),
      metricsEnabled: z.boolean().optional(),
      otlpEndpoint: HTTP_URL.optional(),
      serviceName: NON_EMPTY.optional()
    })
    .optional(),
  features: z
    .strictObject({ agentApi: z.boolean().optional(), webhooks: z.boolean().optional() })
    .optional(),
  workers: z
    .strictObject({
      enabled: z.boolean().optional(),
      pollIntervalFloorMs: POSITIVE_INT.optional(),
      pollIntervalCeilingMs: POSITIVE_INT.optional(),
      transientBackoffMs: POSITIVE_INT.optional(),
      replayBackoffMinMs: POSITIVE_INT.optional(),
      replayBackoffMaxMs: POSITIVE_INT.optional()
    })
    .optional(),
  dataEncryptionKey: secretInFile('dataEncryptionKey').optional(),
  skillsDir: NON_EMPTY.optional(),
  modelAliasesFile: NON_EMPTY.optional()
});

export type ConfigFileData = z.infer<typeof configFileSchema>;

function toConfigIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({ path: formatIssuePath(issue.path), message: issue.message }));
}

function parseFile<S extends z.ZodType>(schema: S, value: unknown, label: string, path: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigValidationError(
      toConfigIssues(parsed.error).map((issue) => ({ path: issue.path, message: `${label} "${path}": ${issue.message}` }))
    );
  }
  return parsed.data;
}

function readJson(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError([{ path: label, message: `could not read ${label} "${path}": ${reason}` }]);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError([{ path: label, message: `${label} "${path}" is not valid JSON: ${reason}` }]);
  }
}

/**
 * Reads and validates the optional JSON config file. Also used internally by
 * `loadConfig`, which merges the result under the environment and CLI layers.
 */
export function readConfigFile(path: string): ConfigFileData {
  return parseFile(configFileSchema, readJson(path, 'config file'), 'config file', path);
}

/** Zod-validated JSON object from `--config <path>`. */
export function loadConfigFile(path: string): unknown {
  return readConfigFile(path);
}

const rateLimitRuleSchema = z.strictObject({
  limit: POSITIVE_INT,
  windowMs: z.number().int().positive().max(3_600_000)
});

const byIdSchema = z.record(NON_EMPTY, rateLimitRuleSchema);

export const rateLimitsFileSchema = z.strictObject({
  global: rateLimitRuleSchema.optional(),
  tenant: z.strictObject({ default: rateLimitRuleSchema.optional(), byId: byIdSchema.optional() }).optional(),
  token: z.strictObject({ default: rateLimitRuleSchema.optional(), byId: byIdSchema.optional() }).optional(),
  tool: z.strictObject({ byName: byIdSchema.optional() }).optional(),
  provider: z.strictObject({ default: rateLimitRuleSchema.optional() }).optional()
});

/** `HF_MCP_RATE_LIMITS_FILE` — admission limits per tenant, token, tool, provider. */
export function loadRateLimitsFile(path: string): RateLimitsFile {
  return parseFile(rateLimitsFileSchema, readJson(path, 'rate limits file'), 'rate limits file', path);
}

const aliasNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'must be an alias identifier');

const pricingSchema = z.strictObject({
  unitMicroUsd: NON_NEGATIVE_INT.optional(),
  perSecondMicroUsd: NON_NEGATIVE_INT.optional(),
  source: NON_EMPTY.optional(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, 'must be an ISO date or timestamp').optional()
});

export const modelAliasesFileSchema = z.strictObject({
  aliases: z.record(aliasNameSchema, NON_EMPTY),
  pricing: z.record(aliasNameSchema, pricingSchema).optional()
});

/** `HF_MCP_MODEL_ALIASES_FILE` — model alias and pricing overrides. */
export function loadModelAliasesFile(path: string): ModelAliasesFile {
  const parsed = parseFile(modelAliasesFileSchema, readJson(path, 'model aliases file'), 'model aliases file', path);

  // The frozen `ModelAliasesFile` declares the pricing fields as strictly
  // optional (never explicitly `undefined`), so entries are rebuilt without
  // undefined members instead of passing the Zod output straight through.
  const pricing: Record<string, { unitMicroUsd?: number; perSecondMicroUsd?: number; source?: string; asOf?: string }> = {};
  for (const [name, entry] of Object.entries(parsed.pricing ?? {})) {
    pricing[name] = {
      ...(entry.unitMicroUsd !== undefined ? { unitMicroUsd: entry.unitMicroUsd } : {}),
      ...(entry.perSecondMicroUsd !== undefined ? { perSecondMicroUsd: entry.perSecondMicroUsd } : {}),
      ...(entry.source !== undefined ? { source: entry.source } : {}),
      ...(entry.asOf !== undefined ? { asOf: entry.asOf } : {})
    };
  }

  return {
    aliases: { ...parsed.aliases },
    ...(parsed.pricing !== undefined ? { pricing } : {})
  };
}

const tenantShapeSchema = z.strictObject({
  tenantId: z.string().min(1).max(128),
  tokenId: z.string().min(1).max(128),
  tokenSha256: z.string().max(128).optional(),
  expiresAt: z.iso.datetime(),
  audience: HTTPS_URL,
  scopes: z.array(NON_EMPTY).min(1),
  providerCredentialsEnv: NON_EMPTY,
  providerAccountId: z.string().min(1).max(128),
  oauthSubject: z.string().min(1).max(256).optional()
});

const tenantsFileSchema = z.strictObject({ tenants: z.array(tenantShapeSchema) });

type TenantShape = z.infer<typeof tenantShapeSchema>;

function checkTenantRecord(record: TenantShape, index: number, issues: ConfigIssue[]): void {
  const at = (field: string) => `tenants[${index}].${field}`;
  const digest = record.tokenSha256 ?? '';
  const hasDigest = digest !== '';
  const hasSubject = record.oauthSubject !== undefined;

  if (hasDigest === hasSubject) {
    issues.push({
      path: at('tokenSha256'),
      message: 'exactly one of tokenSha256 / oauthSubject must be set'
    });
  }
  if (hasDigest && !SHA256_HEX.test(digest)) {
    issues.push({ path: at('tokenSha256'), message: 'must be a 64-character lowercase hex SHA-256 digest' });
  }
  if (record.providerCredentialsEnv.includes(':') || /\s/.test(record.providerCredentialsEnv) || record.providerCredentialsEnv.length > MAX_ENV_VAR_NAME) {
    issues.push({
      path: at('providerCredentialsEnv'),
      message: 'must be the NAME of an environment variable, not a credential value'
    });
  } else if (!ENV_VAR_NAME.test(record.providerCredentialsEnv)) {
    issues.push({ path: at('providerCredentialsEnv'), message: 'must be an uppercase identifier (A-Z, 0-9, _)' });
  }

  const seenScopes = new Set<string>();
  for (const scope of record.scopes) {
    if (seenScopes.has(scope)) issues.push({ path: at('scopes'), message: `duplicate scope "${scope}"` });
    seenScopes.add(scope);
  }
}

/**
 * `HF_MCP_TENANTS_FILE` — the remote-mode credential bindings. Values are
 * digests, environment variable *names*, and public identifiers only; the file
 * never carries a secret or a provider credential.
 */
export function loadTenantsFile(path: string): TenantsFile {
  const parsed = parseFile(tenantsFileSchema, readJson(path, 'tenants file'), 'tenants file', path);
  const issues: ConfigIssue[] = [];

  const tenantIds = new Set<string>();
  const tokenIds = new Set<string>();
  parsed.tenants.forEach((record, index) => {
    checkTenantRecord(record, index, issues);
    if (tenantIds.has(record.tenantId)) issues.push({ path: `tenants[${index}].tenantId`, message: `duplicate tenantId "${record.tenantId}"` });
    tenantIds.add(record.tenantId);
    if (tokenIds.has(record.tokenId)) issues.push({ path: `tenants[${index}].tokenId`, message: `duplicate tokenId "${record.tokenId}"` });
    tokenIds.add(record.tokenId);
  });

  if (issues.length > 0) throw new ConfigValidationError(issues);

  const tenants: TenantRecord[] = parsed.tenants.map((record) => ({
    tenantId: record.tenantId,
    tokenId: record.tokenId,
    // Exactly one binding: a static-token tenant carries the digest and no
    // subject; an OAuth tenant carries only the subject.
    ...(record.tokenSha256 !== undefined && record.tokenSha256 !== '' ? { tokenSha256: record.tokenSha256 } : {}),
    expiresAt: record.expiresAt,
    audience: record.audience,
    scopes: [...record.scopes],
    providerCredentialsEnv: record.providerCredentialsEnv,
    providerAccountId: record.providerAccountId,
    ...(record.oauthSubject !== undefined ? { oauthSubject: record.oauthSubject } : {})
  }));
  return { tenants };
}
