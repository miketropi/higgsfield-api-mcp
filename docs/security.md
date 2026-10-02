# Security

This document states what the gateway actually enforces. Where SPEC §52 lists a requirement,
the implementing file is named.

## Authentication

### Modes

`HF_MCP_AUTH_MODE` selects one of `none`, `static_token`, `oauth_jwt`
(`packages/config/src/types.ts`). Implementation: `apps/server/src/auth.ts`.

- `none` — stdio only. `POST /mcp` rejects every request with `AUTHENTICATION_FAILED`
  ("This gateway does not accept HTTP requests without auth"), and configuration validation
  rejects `http` + `none` outright.
- `static_token` — the bearer token is hashed with SHA-256 and compared against the
  `tokenSha256` field of the tenant records. Comparisons go through `digestEquals`, which is
  length-checked and uses `crypto.timingSafeEqual`. A token is also rejected when
  `expiresAt` has passed or when `HF_MCP_PUBLIC_URL` is set and the tenant `audience` does not
  match it. The default auth mode for `--transport http` is `static_token`.
- `oauth_jwt` — the token is verified with `jose` against the configured issuer, audience,
  and remote JWKS (`HF_MCP_OAUTH_ISSUER`, `HF_MCP_OAUTH_JWKS_URL`, `HF_MCP_OAUTH_AUDIENCE`).
  The JWT `sub` must map to a tenant record's `oauthSubject`; an unmapped subject is rejected.

Failed HTTP authentication returns the SDK's bearer challenge response (with
`WWW-Authenticate`, and the `resource_metadata` parameter when `HF_MCP_PUBLIC_URL` is set).

### RFC 9728 metadata

When `HF_MCP_PUBLIC_URL` is set, the gateway serves
`GET /.well-known/oauth-protected-resource` (and any sub-path) with `resource`,
`bearer_methods_supported: ["header"]`, `scopes_supported`, and — only in `oauth_jwt` mode —
`authorization_servers: [<issuer>]`. Without `HF_MCP_PUBLIC_URL` the route is not registered.

### stdio

stdio has no authentication: the process runs as the implicit local tenant
(`tenantId: "local"`, `tokenId: "stdio-local"`) holding all three scopes. Treat stdio access as
equivalent to local credential access, because it is.

## Authorization

Scopes are `higgsfield:read`, `higgsfield:generate`, `higgsfield:upload`
(`packages/core/src/contracts.ts`). `requireScope` throws `ACCESS_DENIED` with
`details.required_scope` when a verified context lacks the scope; a context with no auth
(stdio) passes.

| Scope | Tools |
|---|---|
| `higgsfield:read` | `models.list`, `models.get`, `capabilities`, `media.get`, `jobs.get`, `jobs.wait`, `jobs.list` |
| `higgsfield:generate` | `generate_image`, `edit_image`, `generate_video`, `animate_image`, `generate`, `jobs.cancel` |
| `higgsfield:upload` | `media.upload` |

Every resource read requires `higgsfield:read`.

## Rate limiting

Dimensions are global, tenant, token, tool, and provider
(`packages/config/src/types.ts`, `RateLimitsFile`). The Redis implementation evaluates all
dimensions in one Lua script and only consumes quota when every dimension admits the request,
so a rejection on one dimension never burns another. The window is a sliding window over
millisecond timestamps.

**Failure policy: closed.** A limiter outage raises `INTERNAL_ERROR` with `retryable: true` and
`details.component = "rate_limiter"` rather than admitting traffic. In Redis deployments the
key namespace is `hf:mcp:rl`, and a shared `{}` hash tag keeps every dimension of one check in
the same cluster slot.

Independently of HTTP admission limits, the submission worker caps concurrent work per class
with `HF_MCP_MAX_IMAGE_JOBS` (default 10), `HF_MCP_MAX_VIDEO_JOBS` (default 3), and 1 for the
`other` class.

The webhook endpoint has its own per-token limit of 60 requests per minute
(`apps/server/src/webhooks/higgsfield.ts`).

## Media: SSRF and path protections

`packages/core/src/media/service.ts` is the only component allowed to read a local file,
download a caller URL, or copy provider bytes.

### Caller-supplied URLs (`remote-fetch.ts`)

- **Scheme**: `https` only. `http`, `file`, and every other scheme are rejected with
  `INVALID_INPUT`.
- **Credentials in the URL**: rejected.
- **Hostname**: `localhost`, the empty hostname, and the suffixes `.localhost`, `.local`,
  `.internal`, `.home.arpa` are rejected before any DNS query.
- **Resolved addresses**: every address returned by DNS must pass `isBlockedAddress`, which
  rejects loopback, RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`,
  `fe80::/10` — including cloud metadata endpoints), CGNAT (`100.64/10`), unspecified,
  documentation, benchmarking, multicast, and reserved ranges, plus IPv6 unique-local
  (`fc00::/7`) and multicast, and IPv4-mapped / NAT64 / `::ffff:` forms of any of the above.
  If any address for a host is blocked, the whole host is rejected.
- **DNS rebinding**: the hostname is resolved once and the validated address is passed to
  Node's `https.request` through its `lookup` option, so Node performs no second resolution;
  TLS SNI and the `Host` header still carry the original hostname.
- **Redirects**: followed manually, at most `HF_MCP_MAX_REDIRECTS` (default 3) hops, each hop
  re-validated by the same rules; a loop is detected and rejected. Redirect bodies are read
  with an 8 KiB cap.
- **Size and time**: bytes are streamed with a hard cap of `HF_MCP_MAX_UPLOAD_BYTES`
  (default 100 MiB) and the download is bounded by `HF_MCP_DOWNLOAD_TIMEOUT_MS` (default 30 s).
- **Content**: the type is sniffed from the bytes, not trusted from the response header, and
  must be an accepted upload type.

### Local files (`local-files.ts`)

Local file input exists only in stdio mode (`localFileAccess` is derived from the transport),
and only under the roots in `HF_MCP_ALLOWED_PATHS`. With no roots configured, local file
access is denied. The read path, in order:

1. configured roots are `realpath`-resolved and cached;
2. the candidate is `realpath`-resolved before any check, so a symlink cannot smuggle it out
   of a root;
3. containment is re-checked on the resolved path (`path.relative` must not escape);
4. the file is opened with `O_RDONLY | O_NOFOLLOW`, so the final component cannot be a
   symlink;
5. the opened handle's `dev`/`ino` must match a fresh `stat` of the resolved path;
6. on Linux, `/proc/self/fd/<n>` is compared with the checked path, closing the swap window;
7. the original path is re-resolved after the open;
8. bytes are read from the handle only, capped at `maxBytes + 1`;
9. the handle is re-`fstat`ed afterwards, so a file changed mid-read is rejected;
10. the media type is sniffed from the content and must be a supported type.

A file that is not a regular file, is empty, exceeds the limit, or changes at any point is
rejected with `INVALID_INPUT`.

### Provider-side guards (`packages/provider-higgsfield/src/paths.ts`)

Provider paths are constructed only from a documented endpoint id, a provider-issued id, or a
provider-issued URL. Path components are restricted to RFC 3986 unreserved characters, and
`assertAllowedProviderPath` admits only the documented fixed shapes
(`/requests/{id}/status`, `/requests/{id}/cancel`, `/files/generate-upload-url`,
`/v1/custom-references[/{id}]`, `/estimate/{endpoint}`) plus catalog model paths. The HTTP
client additionally requires a model path to exist in the bundled catalog, so e.g.
`/estimate/<unknown>` is refused. Provider-issued URLs (signed upload targets, asset URLs) must
be absolute, credential-free, http(s) URLs.

The signed-URL upload sends exactly the provider-returned `upload_headers` and never the
provider `Authorization` header, never default headers, and never follows a redirect.

## Request and response limits

| Limit | Value | Source |
|---|---|---|
| HTTP request body | `HF_MCP_BODY_LIMIT_BYTES` (default 1 MiB) | `apps/server/src/transport/http.ts` |
| Webhook body | 64 KiB | `apps/server/src/webhooks/higgsfield.ts` |
| Upload/download media | `HF_MCP_MAX_UPLOAD_BYTES` (default 100 MiB) | `packages/core/src/media/service.ts` |
| Provider JSON response | 8 MiB | `packages/provider-higgsfield/src/client/http.ts` |
| Signed-URL PUT response | 64 KiB | same |
| Tool input sizes | zod schemas, e.g. `idempotency_key` ≤ 255 characters | `packages/mcp/src/schemas.ts` |

## Error serialization

Errors are allowlisted. `toStructuredError` emits only `code`, `message`, `retryable`,
optional `retry_after_ms`, and sanitized `details`; a non-`GatewayError` exception becomes
`INTERNAL_ERROR` with `details.kind` set to the error class name, never the raw object. No
SDK/HTTP response object, configuration blob, or Axios-style request object is ever
serialized.

`sanitizeDetails` (`packages/core/src/redact.ts`) walks the details value, redacts any key
matching the sensitive-key pattern (`authorization`, `auth`, `credential`, `secret`, `token`,
`password`, `signature`, `apikey`, `api_key`, `key_id`, `access_key`, `x-amz`) with
`[redacted]`, strips the query string from any URL that carries a signed-credential query,
bounds strings at 2048 characters, arrays at 64 items, and depth at 6. The same rules apply to
the job `input_summary`, which never contains raw prompts, media bytes, or provider URLs with
their query strings.

## Webhooks

`POST /webhooks/higgsfield?token=<opaque per-job token>` (`apps/server/src/webhooks/higgsfield.ts`).

**Trust model.** Higgsfield does not document a webhook signature or a shared secret, so the
gateway makes no signature claim and performs no signature verification. A notification is an
**untrusted hint**:

- the per-job opaque callback token authorizes exactly one thing — "reconcile this job";
- the token is looked up by hash (`findSubmissionByCallbackTokenHash`) and compared with
  `digestEquals`; an unknown, missing, or over-long (>512 characters) token returns 404 with no
  body, which does not reveal whether the token existed;
- caller-supplied status, ids, and URLs in the body are ignored entirely;
- the provider status endpoint polled by the worker remains authoritative — a webhook can only
  clear a job's poll backoff so it is reconciled sooner;
- replay resistance comes from token entropy (32 random bytes), coalescing, and idempotent
  terminal processing, not from a timestamp the gateway cannot verify.

| Situation | Response |
|---|---|
| Accepted hint | 202, empty body |
| Method other than POST | 405 `{"error":"method_not_allowed"}` |
| Body over 64 KiB | 413 `{"error":"payload_too_large"}` |
| Missing, empty, or over-long token; unknown token; hash mismatch | 404, no body |
| Over 60 requests/minute for one token | 429 `{"error":"rate_limited"}`, `Retry-After: 30` |

Webhooks are attached to a submission only when `HF_MCP_WEBHOOKS_ENABLED` is true and
`HF_MCP_PUBLIC_URL` is set; the callback URL is
`<HF_MCP_PUBLIC_URL>/webhooks/higgsfield?token=<token>`, and only https URLs are accepted by
the provider adapter.

## Credential handling

- Provider credentials come from the environment (`HF_API_CREDENTIALS`, or the variable named
  by a tenant's `providerCredentialsEnv`) and are resolved per request
  (`apps/server/src/tenants.ts`). Nothing is cached across tenants.
- A credential is sent in exactly one header (`Authorization`) by the provider HTTP client and
  is never logged, echoed in an error message, or attached to a job or asset.
- The tenants file stores SHA-256 digests and environment variable *names*, never tokens or
  credentials. Configuration refuses to read `dataEncryptionKey`, `provider.credentials`,
  `auth.metricsToken`, `storage.accessKeyId`, `storage.secretAccessKey`,
  `persistence.databaseUrl`, and `persistence.redisUrl` from a config file.
- Log redaction is described in [observability.md](observability.md).

## Not implemented

The gateway does not execute shell commands or arbitrary code, does not expose a filesystem
browse API, and does not proxy arbitrary HTTP. `higgsfield.generate` accepts only catalog
endpoint ids — it is not a generic URL fetcher (SPEC §53).
