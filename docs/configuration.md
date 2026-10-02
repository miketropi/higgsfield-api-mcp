# Configuration

## Precedence

`loadConfig` (`packages/config/src/load.ts`) resolves configuration in this order, highest
first:

1. explicit CLI overrides
2. parsed CLI flags (`--transport`, `--host`, `--port`, `--config`)
3. environment variables
4. the JSON config file passed to `--config`
5. built-in defaults (`packages/config/src/defaults.ts`)

The merged result is validated as a whole and every problem is reported at once through
`ConfigValidationError`, whose message lists `<path>: <message>` for each issue (up to 50,
then a `… N more` suffix). Unknown keys inside a config file are rejected; unknown
environment variables are ignored, because the process environment is shared with every
other tool.

## Environment variables

Every key below is read by `packages/config/src/env.ts`; an empty or whitespace-only value
means "not set". Array-valued keys are comma-separated. Defaults are from
`packages/config/src/defaults.ts`.

| Variable | Config path | Default | Meaning |
|---|---|---|---|
| `HF_API_CREDENTIALS` | `provider.credentials` | — | Higgsfield credential string, `Key <id>:<secret>`. Sent as the provider `Authorization` header. |
| `HF_MCP_PROVIDER_ACCOUNT_ID` | `provider.accountId` | derived from the credential id in local mode | Stable upstream account binding, shared across key rotations. |
| `HF_MCP_PROVIDER_BASE_URL` | `provider.baseUrl` | `https://api.higgsfield.ai` | Provider origin. Must be an absolute http(s) URL with no query or fragment. |
| `HF_MCP_PROVIDER_TIMEOUT_MS` | `provider.requestTimeoutMs` | `30000` | Per-request provider timeout. |
| `HF_MCP_PROVIDER_UPLOAD_TIMEOUT_MS` | `provider.uploadTimeoutMs` | `300000` | Timeout for the signed-URL byte upload. |
| `HF_MCP_TRANSPORT` | `transport` | `stdio` | `stdio` or `http`. `http` selects remote mode. |
| `HF_MCP_HOST` | `server.host` | `127.0.0.1` | HTTP listen address. Use `0.0.0.0` in a container. |
| `HF_MCP_PORT` | `server.port` | `3000` | HTTP listen port. |
| `HF_MCP_PUBLIC_URL` | `server.publicUrl` | — | Gateway origin used for callback URLs, the tenant audience check, and the RFC 9728 metadata document. |
| `HF_MCP_ALLOWED_HOSTS` | `server.allowedHosts` | `127.0.0.1,localhost` | DNS-rebinding guard: allowed `Host` hostnames (port-agnostic). `*` is rejected. |
| `HF_MCP_ALLOWED_ORIGINS` | `server.allowedOrigins` | — (none) | Allowed `Origin` hostnames. Requests without an `Origin` header always pass. `*` is rejected. |
| `HF_MCP_BODY_LIMIT_BYTES` | `server.bodyLimitBytes` | `1048576` | Maximum HTTP request body. |
| `HF_MCP_SHUTDOWN_GRACE_MS` | `server.shutdownGraceMs` | `10000` | Drain window after SIGTERM before the process closes. |
| `HF_MCP_AUTH_MODE` | `auth.mode` | `none` (`static_token` when transport is `http`) | `none`, `static_token`, or `oauth_jwt`. |
| `HF_MCP_TENANTS_FILE` | `auth.tenantsFile` | — | Absolute path to the tenants JSON file. Required whenever auth mode is not `none`. |
| `HF_MCP_METRICS_TOKEN` | `auth.metricsToken` | — | Operator bearer token accepted by `GET /metrics`. Without it, `/metrics` always answers 401. |
| `HF_MCP_OAUTH_ISSUER` | `auth.oauth.issuer` | — | Expected JWT issuer (https). |
| `HF_MCP_OAUTH_JWKS_URL` | `auth.oauth.jwksUrl` | — | JWKS endpoint (https). |
| `HF_MCP_OAUTH_AUDIENCE` | `auth.oauth.audience` | — | Expected JWT audience. |
| `HF_MCP_ALLOWED_PATHS` | `media.allowedPaths` | — (deny all) | Absolute directories from which local media files may be read. Only used in stdio mode. |
| `HF_MCP_ASSET_MODE` | `media.assetMode` | `passthrough` | `passthrough` keeps provider URLs; `managed` copies assets into object storage and serves signed URLs. |
| `HF_MCP_MAX_UPLOAD_BYTES` | `media.maxUploadBytes` | `104857600` | Maximum size of one uploaded or downloaded media file. |
| `HF_MCP_DOWNLOAD_TIMEOUT_MS` | `media.downloadTimeoutMs` | `30000` | Timeout for fetching a caller-supplied media URL. |
| `HF_MCP_MAX_REDIRECTS` | `media.maxRedirects` | `3` | Redirect hops allowed while fetching a caller URL (0–10). |
| `HF_MCP_SIGNED_URL_TTL_SECONDS` | `media.signedUrlTtlSeconds` | `900` | Lifetime of managed-asset signed URLs (1–604800). |
| `HF_MCP_S3_ENDPOINT` | `storage.endpoint` | — | S3-compatible endpoint; omit for AWS. |
| `HF_MCP_S3_REGION` | `storage.region` | `us-east-1` | Object store region. |
| `HF_MCP_S3_BUCKET` | `storage.bucket` | — | Bucket for managed assets. |
| `HF_MCP_S3_ACCESS_KEY_ID` | `storage.accessKeyId` | — | Object store access key. |
| `HF_MCP_S3_SECRET_ACCESS_KEY` | `storage.secretAccessKey` | — | Object store secret key. |
| `HF_MCP_S3_FORCE_PATH_STYLE` | `storage.forcePathStyle` | `true` | Path-style addressing, required by most MinIO/S3-compatible servers. |
| `HF_MCP_S3_PREFIX` | `storage.prefix` | `higgsfield` | Key prefix; objects are stored at `<prefix>/<tenantId>/<assetId>`. |
| `HF_MCP_DATA_ENCRYPTION_KEY` | `dataEncryptionKey` | — | Base64 encoding of exactly 32 bytes; encrypts provider bindings at rest and is required in remote mode. |
| `HF_MCP_DATABASE_URL` | `persistence.databaseUrl` | — | PostgreSQL URL (`postgres://…`). Without it the in-memory repository is used. |
| `HF_MCP_REDIS_URL` | `persistence.redisUrl` | — | Redis URL (`redis://…`). Without it the in-memory rate limiter is used. |
| `HF_MCP_MAX_IMAGE_JOBS` | `limits.maxImageJobs` | `10` | Concurrent image-class jobs. |
| `HF_MCP_MAX_VIDEO_JOBS` | `limits.maxVideoJobs` | `3` | Concurrent video-class jobs. |
| `HF_MCP_RATE_LIMITS_FILE` | `limits.rateLimitsFile` | — | Absolute path to the rate-limits JSON file. |
| `HF_MCP_MAX_JOB_COST_USD` | `cost.maxJobCostUsd` | — | Reject a job whose estimate exceeds this. |
| `HF_MCP_DAILY_COST_LIMIT_USD` | `cost.dailyCostLimitUsd` | — | Per-tenant daily spend ceiling (UTC day). |
| `HF_MCP_REQUIRE_CONFIRM_ABOVE_USD` | `cost.requireConfirmAboveUsd` | — | Above this estimate, return `confirmation_required` instead of submitting. |
| `HF_MCP_MODEL_ALIASES_FILE` | `models.aliasesFile` | — | Absolute path to the model-aliases JSON file. |
| `HF_MCP_LOG_LEVEL` | `observability.level` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. |
| `HF_MCP_LOG_PRETTY` | `observability.pretty` | `false` | Accepted for compatibility; `pino-pretty` is not a dependency, so output stays single-line JSON on stderr. |
| `HF_MCP_METRICS_ENABLED` | `observability.metricsEnabled` | `true` | When false every metric method is a no-op and `/metrics` renders an empty exposition. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `observability.otlpEndpoint` | — | OTLP/HTTP trace endpoint. Tracing stays off when unset. |
| `HF_MCP_SERVICE_NAME` | `observability.serviceName` | `higgsfield-mcp` | Service name on log records and the `service` metric label. |
| `HF_MCP_EXPERIMENTAL_AGENT_API` | `features.agentApi` | `false` | Reserved feature flag; no Agent API code path exists. |
| `HF_MCP_WEBHOOKS_ENABLED` | `features.webhooks` | `false` (but see derivations) | Attach a callback URL to provider submissions. |
| `HF_MCP_WORKERS_ENABLED` | `workers.enabled` | `true` | Run the submission/polling worker in this process. |
| `HF_MCP_POLL_INTERVAL_FLOOR_MS` | `workers.pollIntervalFloorMs` | `2000` | Minimum poll interval. |
| `HF_MCP_POLL_INTERVAL_CEILING_MS` | `workers.pollIntervalCeilingMs` | `10000` | Maximum poll interval; must be >= the floor. |
| `HF_MCP_POLL_TRANSIENT_BACKOFF_MS` | `workers.transientBackoffMs` | `60000` | Backoff after a transient provider failure. |
| `HF_MCP_REPLAY_BACKOFF_MIN_MS` | `workers.replayBackoffMinMs` | `2000` | Minimum backoff before replaying an ambiguous submission. |
| `HF_MCP_REPLAY_BACKOFF_MAX_MS` | `workers.replayBackoffMaxMs` | `60000` | Maximum replay backoff; must be >= the minimum. |
| `HF_MCP_SKILLS_DIR` | `skillsDir` | — | Absolute path to the generated skills tree. See [skills.md](skills.md). |

## Derived values

These settings are not configured directly (`packages/config/src/load.ts`):

- `mode` is `remote` when the transport is `http`, otherwise `local`.
- `auth.mode` defaults to `static_token` for `http` and `none` for `stdio`.
- `persistence.requireDatabase` and `persistence.requireRedis` are both `true` exactly when
  `mode` is `remote`.
- `server.allowedHosts` falls back to the hostnames derived from `HF_MCP_PUBLIC_URL`.
- `features.webhooks` defaults to `true` when `HF_MCP_PUBLIC_URL` is set.
- `provider.accountId` is derived from the credential id in local mode.

## Cross-field requirements

`loadConfig` fails fast when any of these is violated:

- Remote mode requires `HF_MCP_DATABASE_URL`, `HF_MCP_REDIS_URL`, `HF_MCP_DATA_ENCRYPTION_KEY`,
  an auth mode other than `none`, and `HF_MCP_PROVIDER_ACCOUNT_ID`.
- `auth.mode` other than `none` requires `HF_MCP_TENANTS_FILE`.
- `oauth_jwt` requires all three of `HF_MCP_OAUTH_ISSUER`, `HF_MCP_OAUTH_JWKS_URL`,
  `HF_MCP_OAUTH_AUDIENCE`; setting any one requires the other two.
- `HF_MCP_ASSET_MODE=managed` requires `HF_MCP_S3_BUCKET`, `HF_MCP_S3_ACCESS_KEY_ID`,
  `HF_MCP_S3_SECRET_ACCESS_KEY`, and `HF_MCP_DATA_ENCRYPTION_KEY`.
- `HF_MCP_DATA_ENCRYPTION_KEY` must be base64 encoding exactly 32 bytes.
- Database and Redis URLs must be absolute URLs with an authority.
- `*` is rejected in `HF_MCP_ALLOWED_HOSTS` and `HF_MCP_ALLOWED_ORIGINS`.
- Every allowed path must be absolute.
- `workers.pollIntervalCeilingMs >= pollIntervalFloorMs` and
  `replayBackoffMaxMs >= replayBackoffMinMs`.

## Config file (`--config <path>`)

The JSON file mirrors the config paths and is strict: an unknown key is a startup failure.
Secrets are rejected by design — the schema declares them present-but-always-failing, with a
message telling the operator to use an environment variable instead. The rejected keys are
`provider.credentials`, `auth.metricsToken`, `storage.accessKeyId`, `storage.secretAccessKey`,
`persistence.databaseUrl`, `persistence.redisUrl`, and `dataEncryptionKey`. Relative file
paths inside the config resolve against the working directory.

```json
{
  "transport": "http",
  "server": { "host": "0.0.0.0", "port": 3000, "publicUrl": "https://gateway.example.com" },
  "media": { "assetMode": "passthrough", "allowedPaths": ["/srv/media"] },
  "limits": { "maxImageJobs": 10, "maxVideoJobs": 3 },
  "observability": { "level": "info", "metricsEnabled": true }
}
```

## Tenants file (`HF_MCP_TENANTS_FILE`)

Schema in `packages/config/src/files.ts`. Each record is strict:

| Field | Rule |
|---|---|
| `tenantId` | 1–128 characters, unique. |
| `tokenId` | 1–128 characters, unique; becomes the `clientId` of the authenticated request. |
| `tokenSha256` | Optional. Exactly one of `tokenSha256` / `oauthSubject` must be present. Lowercase 64-character hex SHA-256 of the bearer token. |
| `oauthSubject` | Optional. The JWT `sub` mapped to this tenant. |
| `expiresAt` | ISO-8601 timestamp; an expired token is rejected. |
| `audience` | Must be an absolute **https** URL, and must equal `HF_MCP_PUBLIC_URL` when that is set. |
| `scopes` | Non-empty array, no duplicates; the accepted values are `higgsfield:read`, `higgsfield:generate`, `higgsfield:upload`. |
| `providerCredentialsEnv` | The **name** of an environment variable holding the provider credential — never the credential itself. Uppercase identifier, at most 64 characters. |
| `providerAccountId` | 1–128 characters; the stable upstream account binding. |

The file never carries a secret: tokens live only in the environment of whatever holds the
client.

```json
{
  "tenants": [
    {
      "tenantId": "acme",
      "tokenId": "acme-token-1",
      "tokenSha256": "<64 lowercase hex characters>",
      "expiresAt": "2027-01-01T00:00:00.000Z",
      "audience": "https://gateway.example.com",
      "scopes": ["higgsfield:read", "higgsfield:generate", "higgsfield:upload"],
      "providerCredentialsEnv": "ACME_HF_CREDENTIALS",
      "providerAccountId": "acct_acme"
    }
  ]
}
```

## Rate limits file (`HF_MCP_RATE_LIMITS_FILE`)

Every rule is `{ "limit": <positive integer>, "windowMs": <positive integer, max 3600000> }`.
All dimensions are evaluated and only then consumed, so a request rejected on one dimension
does not spend quota on another.

```json
{
  "global": { "limit": 120, "windowMs": 60000 },
  "tenant": { "default": { "limit": 120, "windowMs": 60000 }, "byId": {} },
  "token": { "default": { "limit": 120, "windowMs": 60000 }, "byId": {} },
  "tool": { "byName": { "higgsfield.generate_video": { "limit": 5, "windowMs": 60000 } } },
  "provider": { "default": { "limit": 60, "windowMs": 60000 } }
}
```

## Model aliases file (`HF_MCP_MODEL_ALIASES_FILE`)

```json
{
  "aliases": { "image.fast": "xai/grok-imagine-image-2.0" },
  "pricing": { "soul-id": { "unitMicroUsd": 120000, "source": "contract", "asOf": "2026-10-01" } }
}
```

An alias must point at a model id present in the catalog, or configuration fails. Pricing
overrides take precedence over the provider estimate endpoint and are applied to the
registry entry.
