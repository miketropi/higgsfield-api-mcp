import { z } from 'zod';
import { AUTH_MODES, ASSET_MODES, LOG_LEVELS, TRANSPORT_MODES } from './defaults.js';

/** Absolute http(s) URL with no embedded credentials. */
export const HTTP_URL = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}, 'must be an absolute http(s) URL without embedded credentials');

/** Absolute https URL with no embedded credentials. */
export const HTTPS_URL = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}, 'must be an absolute https URL without embedded credentials');

export const POSITIVE_INT = z.number().int().positive();
export const NON_NEGATIVE_INT = z.number().int().min(0);
export const NON_EMPTY = z.string().min(1);
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;
export const MAX_ENV_VAR_NAME = 64;

/**
 * Authoritative validation of the fully merged configuration. Cross-field
 * requirements run alongside this schema so a single `loadConfig` call reports
 * every problem at once.
 */
export const gatewayConfigSchema = z.strictObject({
  transport: z.enum(TRANSPORT_MODES),
  mode: z.enum(['local', 'remote']),
  server: z.strictObject({
    host: NON_EMPTY,
    port: z.number().int().min(1).max(65_535),
    publicUrl: HTTP_URL.optional(),
    allowedHosts: z.array(NON_EMPTY).min(1),
    allowedOrigins: z.array(NON_EMPTY),
    bodyLimitBytes: POSITIVE_INT,
    shutdownGraceMs: NON_NEGATIVE_INT
  }),
  auth: z.strictObject({
    mode: z.enum(AUTH_MODES),
    tenantsFile: NON_EMPTY.optional(),
    metricsToken: NON_EMPTY.optional(),
    oauth: z.strictObject({ issuer: HTTPS_URL, jwksUrl: HTTPS_URL, audience: NON_EMPTY }).optional()
  }),
  provider: z.strictObject({
    credentials: NON_EMPTY.optional(),
    accountId: NON_EMPTY.optional(),
    baseUrl: HTTP_URL,
    requestTimeoutMs: POSITIVE_INT,
    uploadTimeoutMs: POSITIVE_INT
  }),
  media: z.strictObject({
    allowedPaths: z.array(NON_EMPTY),
    assetMode: z.enum(ASSET_MODES),
    maxUploadBytes: POSITIVE_INT,
    downloadTimeoutMs: POSITIVE_INT,
    maxRedirects: z.number().int().min(0).max(10),
    signedUrlTtlSeconds: z.number().int().min(1).max(604_800)
  }),
  storage: z.strictObject({
    endpoint: NON_EMPTY.optional(),
    region: NON_EMPTY,
    bucket: NON_EMPTY.optional(),
    accessKeyId: NON_EMPTY.optional(),
    secretAccessKey: NON_EMPTY.optional(),
    forcePathStyle: z.boolean(),
    prefix: z.string()
  }),
  persistence: z.strictObject({
    databaseUrl: NON_EMPTY.optional(),
    redisUrl: NON_EMPTY.optional(),
    requireDatabase: z.boolean(),
    requireRedis: z.boolean()
  }),
  limits: z.strictObject({
    maxImageJobs: POSITIVE_INT,
    maxVideoJobs: POSITIVE_INT,
    rateLimitsFile: NON_EMPTY.optional()
  }),
  models: z.strictObject({
    aliasesFile: NON_EMPTY.optional()
  }),
  cost: z.strictObject({
    maxJobCostUsd: z.number().min(0).optional(),
    dailyCostLimitUsd: z.number().min(0).optional(),
    requireConfirmAboveUsd: z.number().min(0).optional()
  }),
  observability: z.strictObject({
    level: z.enum(LOG_LEVELS),
    pretty: z.boolean(),
    metricsEnabled: z.boolean(),
    otlpEndpoint: HTTP_URL.optional(),
    serviceName: NON_EMPTY
  }),
  features: z.strictObject({
    agentApi: z.boolean(),
    webhooks: z.boolean()
  }),
  workers: z.strictObject({
    enabled: z.boolean(),
    pollIntervalFloorMs: POSITIVE_INT,
    pollIntervalCeilingMs: POSITIVE_INT,
    transientBackoffMs: POSITIVE_INT,
    replayBackoffMinMs: POSITIVE_INT,
    replayBackoffMaxMs: POSITIVE_INT
  }),
  dataEncryptionKey: NON_EMPTY.optional(),
  skillsDir: NON_EMPTY.optional(),
  configFile: NON_EMPTY.optional()
});
