# Observability

## Structured logging

Logging is pino (`packages/observability/src/logger.ts`). Every record is single-line JSON on
**stderr** — in stdio mode stdout is the JSON-RPC channel, and a single log line written there
would corrupt the protocol stream. This is enforced by construction: the logger is created
with `process.stderr` as its destination.

Base fields on every record: `pid`, `hostname`, `service` (`HF_MCP_SERVICE_NAME`), `level`,
`time`, and the optional `msg`. Request-scoped records add `request_id` where the call site
supplies it, and generation records add `job_id` (see the per-event table below).

`HF_MCP_LOG_LEVEL` accepts `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`; an
unrecognised value falls back to `info`. `HF_MCP_LOG_PRETTY` is accepted for configuration
compatibility but has no effect: `pino-pretty` is deliberately not a dependency, so
`describePrettySupport()` returns `false` and output stays JSON.

### Redaction

Two independent layers:

1. **Key-based (pino `redact`)** — these paths are replaced with `[redacted]`:
   `authorization`, `credentials`, `token`, `secret`, `password`, `apiKey`, `api_key`
   (each at the top level and one or two nesting levels down, including
   `headers.authorization`), `accessKeyId`, `secretAccessKey`, `upload_headers`, and
   `cookie`.
2. **Value-based (`sanitizeUrlFields` formatter)** — any key whose name ends in `url` is
   rewritten with `safeUrlForLogging`, which strips the query string (`?[redacted]`) and
   removes embedded username/password; the walk descends up to three levels. Signed upload
   targets and asset URLs therefore never leak their query strings.

`packages/core/src/redact.ts` provides the same primitives for error details and job
summaries (`isSensitiveKey`, `safeUrlForLogging`, `hasSensitiveQuery`, `sanitizeDetails`), so
log, error, and MCP-response redaction cannot drift apart.

### Log events

Records that carry an `event` field, by area:

| Event | Level | Notable fields |
|---|---|---|
| `transport.ready` | info | `transport`, `host`, `port` (http) |
| `http.mcp_request` | debug | `method`, `request_id` |
| `mcp.handler_error` | error | `err` (error class name) |
| `mcp.stdio_error` | error | `err` |
| `mcp.tool_error` | warn | `tool`, `code`, `request_id` |
| `mcp.output_invalid` | error | `tool`, `issue` |
| `generation.submitted` | info | `job_id`, `tool`, `endpoint` |
| `generation.idempotent_reuse` | info | `job_id`, `tool` |
| `generation.confirmation_required` | info | `tool`, `endpoint` |
| `generation.completed` | info | `job_id`, `status`, `duration_ms` |
| `generation.poll_skipped` | warn | `job_id`, `submission_state` |
| `generation.poll_failed` | warn | `job_id`, `code`, `failures` |
| `generation.submit_retry` | warn | `job_id`, `code`, `attempts` |
| `generation.submit_rejected` | warn | `job_id`, `code` |
| `generation.submission_outcome_unknown` | error | `job_id`, `code` |
| `worker.reconciled` | info | `polled`, `completed` |
| `worker.idle` | debug | — |
| `worker.nudge_failed` | warn | `job_id`, `code` |
| `worker.tick_failed` | error | `code` |
| `cost.estimate_failed` | warn | `endpoint`, `err` |
| `provider.credentials_missing` | error | `tenant_id`, `env` |
| `webhook.received` | info | `job_id` |
| `webhook.unknown_token` | warn | — |
| `webhook.rate_limited` | warn | — |
| `migration_applied` | info | `component`, `file` |
| `pool_error` | warn | `component`, `error` |
| `client_error`, `check_failed`, `close_failed`, `rollback_failed` | warn | `component`, `error` |
| `gateway.signal` | info | `signal` |
| `gateway.shutdown` | info | — |

A few informational records (for example the media service's "Media asset stored." record)
carry structured fields but no `event` key.

## Metrics

Prometheus exposition at `GET /metrics`, implemented with `prom-client`
(`packages/observability/src/metrics.ts`). The endpoint requires
`Authorization: Bearer <HF_MCP_METRICS_TOKEN>`; without a configured token, or with a wrong
token, it answers 401 with `WWW-Authenticate: Bearer realm="metrics"`. With
`HF_MCP_METRICS_ENABLED=false`, every recording method is a no-op and `render()` returns an
empty exposition, so callers never branch on whether metrics are enabled.

| Metric | Type | Labels |
|---|---|---|
| `mcp_tool_calls_total` | counter | `tool`, `transport` (`stdio` \| `http`) |
| `mcp_tool_errors_total` | counter | `tool`, `code` |
| `generation_jobs_total` | counter | `provider`, `capability`, `job_kind` |
| `generation_job_duration_seconds` | histogram | `provider`, `capability`, `job_kind`, `status` |
| `provider_requests_total` | counter | `provider`, `endpoint`, `outcome` (`ok` \| `error`) |
| `provider_errors_total` | counter | `provider`, `code` |
| `media_upload_bytes_total` | counter | `direction` (`in` \| `out`) |
| `estimated_cost_usd_total` | counter | — |
| `active_jobs` | gauge | `concurrency_class` |
| `queued_jobs` | gauge | `concurrency_class` |

Every series also carries the default label `service` (`HF_MCP_SERVICE_NAME`). Histogram
buckets are `0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800` seconds.

Label values are sanitised before use: characters outside `[A-Za-z0-9_.:-]` are removed and
the value is truncated to 64 characters, which caps cardinality growth and keeps the
exposition format parseable. Non-finite or negative durations and byte counts are dropped
rather than recorded.

`estimated_cost_usd_total` accumulates the estimated cost of admitted jobs (micro-USD divided
by 1e6); it is a monotonic counter, not a running account balance.

## Tracing

OTLP/HTTP trace export (`packages/observability/src/tracing.ts`) is enabled only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set; `initTracing` then starts a `NodeSDK` with an
`OTLPTraceExporter` for the configured service name. When the endpoint is unset, tracing stays
off and the OpenTelemetry API's no-op tracer keeps working. A misconfigured collector never
stops the gateway: `initTracing` catches startup failures and returns `undefined`, and
shutdown swallows exporter errors.

## Known gaps

SPEC §42 requires every request to carry `request_id` and `trace_id`, and generation
additionally `job_id` and `provider_job_id`. Current state, verified:

- `request_id` is generated per request (`req_<…>`) and appears on `mcp.tool_error` and
  `http.mcp_request`. Other records (including `generation.*` and the repository/worker
  records) do not carry it.
- `provider_job_id` is persisted on the job and returned in both the job object and
  `generation.submitted`-adjacent metadata, but it is not a field on every log record.
- **No record emits `trace_id`.** `currentTraceContext()` exists in
  `packages/observability/src/tracing.ts` and is exported, but no call site uses it, and no
  spans are created around tool calls, generation, or polling. A deployment that enables
  OTLP export today gets SDK-provided spans for whatever the instrumentation hooks, not a
  correlated MCP request trace.
