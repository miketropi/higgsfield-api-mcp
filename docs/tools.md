# Tools and resources

Tool inputs are frozen public API: snake_case, additive changes only. Every input object is
strict — an unknown field is an error, not a silent no-op. Internal models are camelCase, and
`packages/mcp/src/serialize.ts` is the only place the translation to the wire shape happens.

## Common request fields

These four fields are accepted by the generation tools (`higgsfield.generate_image`,
`higgsfield.edit_image`, `higgsfield.generate_video`, `higgsfield.animate_image`,
`higgsfield.generate`):

| Field | Type | Meaning |
|---|---|---|
| `wait` | boolean | Wait for a terminal state before answering. Bounded by the gateway maximum. |
| `idempotency_key` | string (1–255) | Client key. A repeat with the same key reuses the existing job instead of submitting again. |
| `workspace_id` | string | Attached to the job and used to scope job listings. |
| `confirmation_token` | string | Resumes a request that previously returned `confirmation_required`. |

### Media references

Every media input is a discriminated union:

```jsonc
{ "type": "url",   "url": "https://…" }        // fetched by the gateway
{ "type": "asset", "asset_id": "asset_…" }     // a previously stored asset
{ "type": "file",  "path": "/abs/path.png" }   // stdio only, inside HF_MCP_ALLOWED_PATHS
```

## Tools

### `higgsfield.generate_image`

Generate an image from a prompt. Scope: `higgsfield:generate`. Semantic endpoint `image.default`.

| Input | Type | Notes |
|---|---|---|
| `prompt` | string | Required. |
| `negative_prompt` | string | Only if the selected model documents it. |
| `aspect_ratio` | string | Must be one of the model's documented ratios. |
| `width`, `height` | integer | Not supported by any current catalog model; rejected as `INVALID_INPUT`. |
| `quality` | `draft` \| `standard` \| `high` | Translated to the model's vocabulary (`draft` → `low`, `standard` → `medium`). |
| `style` | string | Not supported by any current catalog model. |
| `reference_images` | media reference[] | Switches the capability to `reference_images`. |
| `model` | string | Explicit catalog id or alias; overrides the default. |
| `seed` | integer | Only if the model documents it. |
| `count` | integer | Values above 1 are rejected (no documented batch field). |

Output: a job object or a confirmation object.

### `higgsfield.edit_image`

Edit or restyle an existing image. Scope: `higgsfield:generate`. Semantic endpoint `image.edit`.
Default model `alibaba/qwen-image-3/edit`.

| Input | Type | Notes |
|---|---|---|
| `prompt` | string | Required. |
| `image` | media reference | Required; becomes the first `image_urls` entry. |
| `mask` | media reference | Not supported by the current edit model; rejected. |
| `references` | media reference[] | Appended after `image`. |
| `preserve_identity` | boolean | Not supported by the current edit model; rejected. |
| `model`, `aspect_ratio`, `seed` | | As above. |

### `higgsfield.generate_video`

Generate a video from a prompt, optionally with a start frame, an end frame, or references.
Scope: `higgsfield:generate`. Semantic endpoint `video.default`, which selects the endpoint
from the inputs you send — no single published endpoint accepts every shape:

| Inputs present | Endpoint |
|---|---|
| nothing (text only) | `kling-video/v2.5-turbo/pro/text-to-video` |
| `start_image` | `kling-video/v2.5-turbo/pro/image-to-video` |
| `end_image` (requires `start_image`) | `bytedance/seedance-2.5/image-to-video` |
| `references` | `bytedance/seedance-2.5/reference-to-video` |

Fields: `prompt` (required), `start_image`, `end_image`, `references[]`, `duration`,
`aspect_ratio`, `resolution`, `audio`, `model`, `quality`. A field the selected endpoint does
not document is rejected rather than dropped.

### `higgsfield.animate_image`

Animate a still image into a short video. Scope: `higgsfield:generate`. Semantic endpoint
`video.image_to_video`. Fields: `image` (required), `prompt` (required), `duration`,
`motion_strength`, `camera_motion`, `model`.

### `higgsfield.generate`

Provider-native generation. Scope: `higgsfield:generate`. The `endpoint` must be an id present
in `higgsfield.models.list`; arbitrary URLs are not accepted.

| Input | Type | Notes |
|---|---|---|
| `endpoint` | string | Required catalog endpoint id, e.g. `xai/grok-imagine-image-2.0`, `soul-id`. |
| `input` | object | Required. Provider-native flat fields, validated against the endpoint's published schema. |
| `webhook` | `{ "url": string }` | Optional https callback URL; only used when webhooks are enabled. |

Nested `asset_id` references inside `input` are converted to internal asset references;
`image_urls` style arrays accept the `asset` form.

### `higgsfield.media.upload`

Upload a local file (stdio only) or a public https URL and get an asset reference. Scope:
`higgsfield:upload`.

| Input | Type | Notes |
|---|---|---|
| `source` | `{ "path": string }` \| `{ "url": string }` | Required, exactly one form. |
| `media_type` | `image` \| `video` \| `audio` | Optional; must match the detected content type. |

Output: an asset object.

### `higgsfield.media.get`

Return metadata for an asset owned by the calling tenant, with a fresh signed URL in managed
mode. Scope: `higgsfield:read`. Input: `asset_id`. An asset that does not exist and an asset
belonging to another tenant both return `ACCESS_DENIED`.

### `higgsfield.models.list`

Scope: `higgsfield:read`. Inputs: `type` (`image` \| `video` \| `audio` \| `3d`) and
`capability` (string). Output: `{ "models": [ { id, name, type, status, capabilities } ] }`,
sorted by id.

### `higgsfield.models.get`

Scope: `higgsfield:read`. Input: `model` (catalog id or alias). Output: the full model object —
`id`, `name`, `type`, `status`, `capabilities`, `endpoint`, `limits`, optional `input_schema`,
optional `pricing` (`currency`, `unit_micro_usd`, `per_second_micro_usd`, `source`, `as_of`),
and `source` (`url`, `as_of`).

### `higgsfield.capabilities`

Scope: `higgsfield:read`. Input: none (an empty object). Output:

```jsonc
{
  "gateway_version": "0.1.0",
  "mcp_protocol": "2026-07-28",
  "provider": { "id": "higgsfield", "version": "0.1.0" },
  "skills_version": "0.1.0+upstream.0.13.0",
  "capabilities": ["audio_generation", "image_edit", "image_generation", "..."],
  "auth": { "mode": "none", "scopes": ["higgsfield:read", "higgsfield:generate", "higgsfield:upload"] },
  "limits": { "max_wait_ms": 25000, "max_image_jobs": 10, "max_video_jobs": 3 }
}
```

`skills_version` is `<adapterVersion>+upstream.<version>` from the skills manifest, or
`unavailable` when no skills tree is resolved.

### `higgsfield.jobs.get`

Scope: `higgsfield:read`. Input: `job_id`. Output: the job object. A job that does not exist
and a job owned by another tenant are indistinguishable (`JOB_NOT_FOUND`).

### `higgsfield.jobs.wait`

Scope: `higgsfield:read`. Inputs: `job_id`, optional `timeout_ms` (default 20000, capped at the
gateway maximum of 25000). A timeout returns the still-running job; it never cancels it.

### `higgsfield.jobs.cancel`

Scope: `higgsfield:generate`. Input: `job_id`.

- A job that has not been accepted by the provider yet is cancelled before submission.
- A job whose submission is in flight or ambiguous is returned unchanged with
  `metadata.cancellation_rejected = "submission_in_flight"` — the gateway never reports a
  cancellation it cannot prove.
- An accepted provider cancellation returns `status: "cancelled"` with
  `metadata.cancellation_pending_reconcile = true`; polling reconciles the final state.
- A provider refusal (for example, processing already started) returns the job unchanged with
  `metadata.cancellation_rejected` naming the reason.

### `higgsfield.jobs.list`

Scope: `higgsfield:read`. Input: optional `cursor`. Output:
`{ "jobs": [...], "next_cursor": "…" }`, newest first, limited to 50 jobs per page.

## Serialized objects

### Job

| Field | Notes |
|---|---|
| `job_id` | `job_<32 hex>`. |
| `status` | `queued` \| `processing` \| `completed` \| `failed` \| `cancelled`. |
| `provider` | Provider id (`higgsfield`). |
| `provider_job_id` | Opaque adapter handle; only present once acknowledged. |
| `capability` | Primary capability, e.g. `image_generation`. |
| `model`, `endpoint` | Present when resolved from the catalog. |
| `workspace_id` | Present when supplied. |
| `created_at`, `updated_at` | ISO-8601. |
| `input_summary` | Public-safe summary: string values become `{ "length": n }`, URL-valued keys are stripped of their query string, arrays become `{ "count": n }`, nested objects become `{ "keys": [...] }`. Prompts and media bytes are never echoed. |
| `assets` | Array of asset objects. |
| `cost` | Optional `{ currency: "USD", estimated_cost_usd?, actual_cost_usd?, source }`. |
| `error` | Optional error object. |
| `metadata` | Optional sanitized provider metadata (for example `provider_status`, `custom_reference_id`). |

### Asset

`asset_id`, `url`, `media_type`, `mime_type`, `created_at`, optional `size`, `width`, `height`,
`duration_seconds`, `expires_at`.

## Resources

| URI | Body | MIME | Scope | Cache hint |
|---|---|---|---|---|
| `higgsfield://capabilities` | The capabilities object | `application/json` | `higgsfield:read` | 60 s, public |
| `higgsfield://models` | `{ "models": [ …summaries… ] }` | `application/json` | `higgsfield:read` | 60 s, public |
| `higgsfield://models/{id}` | The full model object | `application/json` | `higgsfield:read` | 60 s, public |
| `higgsfield://jobs/{id}` | The job object | `application/json` | `higgsfield:read` | 0 s, private |
| `higgsfield://assets/{id}` | The asset object | `application/json` | `higgsfield:read` | 0 s, private |

A resource body that fails its schema check is reported as `INTERNAL_ERROR` rather than
returned unvalidated.

## Errors

A failed tool call returns `isError: true` with the envelope as its text content:

```json
{
  "error": {
    "code": "MODEL_NOT_FOUND",
    "message": "Unknown model: nope.",
    "retryable": false,
    "retry_after_ms": 1500,
    "details": { "model": "nope" }
  }
}
```

`retry_after_ms` is present only when known; `details` is always sanitized (sensitive keys
replaced with `[redacted]`, signed-URL query strings stripped).

| Code | Retryable | HTTP status when mapped | Typical cause |
|---|---|---|---|
| `AUTHENTICATION_FAILED` | no | 401 | Missing or invalid credential; also used when the provider rejects the configured credentials. |
| `ACCESS_DENIED` | no | 403 | Missing scope, or an asset/job that is not available to this tenant. |
| `INSUFFICIENT_CREDITS` | no | 402 | Provider account has no credits. |
| `INVALID_INPUT` | no | 400 | Validation failure, unsupported field for the selected model, blocked media URL/host. |
| `MODEL_NOT_FOUND` | no | 404 | Unknown model id or endpoint. |
| `MODEL_UNAVAILABLE` | no | 409 | Model disabled, temporarily blocked, or an alias that cannot perform the capability. |
| `RATE_LIMITED` | yes | 429 | Local admission limit or provider concurrency/rate limit. |
| `MEDIA_UPLOAD_FAILED` | yes | 502 | Local read failure, download failure, or a failed upload to the provider. |
| `JOB_NOT_FOUND` | no | 404 | Unknown job for this tenant. |
| `JOB_FAILED` | no | 422 | The provider reported the generation failed. |
| `TIMEOUT` | yes | 504 | Provider request or media download exceeded its timeout. |
| `CANCELLED` | no | 409 | The request was cancelled. |
| `COST_LIMIT_EXCEEDED` | no | 402 | Estimate above `HF_MCP_MAX_JOB_COST_USD`. |
| `POLICY_REJECTED` | no | 403 | Provider content policy (`nsfw`), an invalid confirmation token, or an unknown price while cost limits are configured. |
| `PROVIDER_ERROR` | yes | 502 | Provider failure, redirect, or unusable provider response. |
| `INTERNAL_ERROR` | yes | 500 | Unexpected gateway failure, including an unvalidated serialized payload. |

## Confirmation flow

When `HF_MCP_REQUIRE_CONFIRM_ABOVE_USD` is set and the estimate exceeds it, the tool returns:

```json
{
  "status": "confirmation_required",
  "estimated_cost_usd": 0.42,
  "confirmation_token": "<opaque>",
  "expires_at": "2026-10-02T00:10:00.000Z"
}
```

The token is bound to the tenant, the tool, and a hash of the request, expires after ten
minutes, and is consumed exactly once. Repeat the identical call with
`confirmation_token` added. A changed request, a different tool, a different tenant, or a
second use is rejected with `POLICY_REJECTED`.
