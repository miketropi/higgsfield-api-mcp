# Deployment

## Container image

`Dockerfile` is multi-stage and starts from `node:22-slim` pinned by digest
(`sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`, the multi-arch
index resolved from Docker Hub; the `NODE_IMAGE` build argument carries it).

**Build stage** installs with `pnpm install --frozen-lockfile` using the pnpm version pinned
by the root `packageManager` field (via corepack), runs `pnpm -r run build`, reinstalls the
production dependency closure only, and stages the assets that the bundle does not carry:
the generated skills tree, the model catalog (provenance only), and the PostgreSQL migration
`.sql` files.

**Runtime stage** carries only the production dependency closure and `apps/server/dist`, runs
as uid/gid `10001` (`gateway`), sets `NODE_ENV=production`, `EXPOSE 3000`, and:

```dockerfile
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HF_MCP_PORT || 3000) + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "apps/server/dist/cli.js", "serve", "--transport", "http", "--host", "0.0.0.0"]
```

The healthcheck is a non-billable static probe: `/health` calls no provider endpoint (SPEC
§45 requires exactly that).

### Read-only root filesystem

The image is built for a read-only root and **must** be run with a writable `/tmp`:

```bash
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  -e HF_MCP_TRANSPORT=http -e HF_MCP_HOST=0.0.0.0 -e HF_MCP_PORT=3000 \
  -e HF_MCP_AUTH_MODE=static_token -e HF_MCP_TENANTS_FILE=/etc/higgsfield/tenants.json \
  -e HF_MCP_METRICS_TOKEN=... -e HF_MCP_DATA_ENCRYPTION_KEY=... \
  -e HF_MCP_DATABASE_URL=postgres://... -e HF_MCP_REDIS_URL=redis://... \
  -e HF_MCP_PROVIDER_ACCOUNT_ID=... -e HF_API_CREDENTIALS='Key …' \
  -v /srv/higgsfield/tenants.json:/etc/higgsfield/tenants.json:ro \
  -p 127.0.0.1:3000:3000 higgsfield-mcp:local
```

The gateway writes nothing outside `/tmp` and the object store. The distributed lockfile, the
SQL and Redis write paths, and the object store each keep their own storage.

### Migrations before startup

`higgsfield-mcp migrate` is the only supported way to create schema; the repository never runs
DDL implicitly, so a rolling deploy cannot race itself into a half-applied schema. Run it as a
one-shot job before the gateway starts, using an image that ships the migrations at
`apps/server/dist/migrations`:

```bash
docker run --rm --read-only --tmpfs /tmp \
  -e HF_MCP_DATABASE_URL=postgres://... \
  --entrypoint node higgsfield-mcp:local apps/server/dist/cli.js migrate
```

Migrations take one session-level PostgreSQL advisory lock for the whole run, apply each file
in its own transaction together with its `schema_migrations` row, and are a no-op when re-run.

## Compose integration stack

`docker-compose.yml` brings up a reproducible stack. Values marked `required` come from a local,
git-ignored `.env` (start from `.env.example`); the file itself never contains a credential.

| Service | Role | Healthcheck | Published |
|---|---|---|---|
| `postgres` | Job/asset/submission persistence | `pg_isready` | `127.0.0.1:${POSTGRES_PORT:-5432}` |
| `redis` | Rate limiting (password required) | `redis-cli ping` | `127.0.0.1:${REDIS_PORT:-6379}` |
| `objectstore` | S3-compatible object store (SeaweedFS in the MinIO role), bucket created at startup | unauthenticated HTTP probe on `:8333` | `127.0.0.1:${HF_MCP_S3_PORT:-8333}` |
| `migrate-init` | One-shot: runs `node apps/server/dist/cli.js migrate` | exits 0 | — |
| `tenants-init` | One-shot: derives `tenants.json` (SHA-256 digest of the dev token) into a named volume | exits 0 | — |
| `gateway` | The MCP gateway | HTTP healthcheck | `127.0.0.1:${HF_MCP_GATEWAY_PORT:-3000}` |

The gateway service depends on the three infrastructure healthchecks and on both init jobs
completing successfully, so migrations always precede the first request. It runs with
`read_only: true`, a `/tmp` tmpfs, `user: "10001:10001"`, `cap_drop: [ALL]`,
`no-new-privileges`, and `stop_grace_period: 30s`.

```bash
cp .env.example .env      # replace the placeholders
docker compose up -d
docker compose ps
curl -s http://127.0.0.1:3000/health
curl -s -H "Authorization: Bearer $HF_MCP_METRICS_TOKEN" http://127.0.0.1:3000/metrics
docker compose down -v
```

`--wait` only understands long-running services, so infrastructure-only runs use:

```bash
docker compose up -d --wait postgres redis objectstore
```

Every published port is bound to `127.0.0.1`, `HF_MCP_ALLOWED_HOSTS` defaults to
`127.0.0.1,localhost`, and no wildcard origin is allowed.

## SIGTERM and graceful shutdown

On `SIGTERM` (or `SIGINT`) the gateway (`apps/server/src/cli.ts`):

1. stops admitting new HTTP MCP work (`stopAdmission()`), answering later requests with 503
   `RATE_LIMITED` and `Retry-After: 5`;
2. waits `HF_MCP_SHUTDOWN_GRACE_MS` (default 10 s) so in-flight requests drain;
3. stops the submission worker, closes the repository and the rate limiter, and shuts down the
   tracer;
4. exits 0.

Remote provider jobs are **not** cancelled by shutdown. Because a job is persisted before its
submission is attempted, the next process reconciles it on startup (`reconcileOnStartup()`),
using the stored idempotency key and submission envelope.

## Secrets

- Provider credentials, database/Redis URLs, the metrics token, object-store keys, and the data
  encryption key come from the environment (or an orchestrator secret file mounted read-only).
- Configuration refuses to read those values from a config file
  (see [configuration.md](configuration.md)).
- The tenants file holds digests and environment variable *names* only.
- `.env` is git-ignored and excluded from the image build context.

## Health, readiness, scaling

- `GET /health` — liveness only: static JSON with `status`, `version`, and `uptime_s`.
- `GET /ready` — readiness: `repository`, `rate_limiter`, `object_storage` (when a bucket is
  configured), `provider_catalog`, and `provider_credentials`. Returns 503 with
  `status: "not_ready"` and the per-check map when any check fails.
- `GET /metrics` — Prometheus exposition, operator bearer token required.

The worker runs inside the gateway process when `HF_MCP_WORKERS_ENABLED` is true (the
default), so each replica polls. Job claiming uses short leases and PostgreSQL transactions,
and provider submissions carry a persisted idempotency key, so a replica restarted mid-flight
replays an identical request rather than duplicating one. An ambiguous submission to an
endpoint without a documented idempotency guarantee is never replayed automatically; it is
recorded as an unknown outcome for operator reconciliation with
`higgsfield-mcp jobs reconcile <job-id> --provider-job-id <id> --tenant <t>`.
