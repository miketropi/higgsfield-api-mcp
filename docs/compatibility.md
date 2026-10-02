# Compatibility

Honest status per surface. "Stable" means exercised by unit, contract, and integration tests
plus the end-to-end harness; "supported" for the provider means a documented catalog entry
exists; a skill's status is its classification in `skills/manifest.json`.

## Feature matrix (SPEC §70)

| Feature | MCP | Higgsfield API | Skill | Notes |
|---|---|---|---|---|
| Image generation | Stable | Supported | `higgsfield-generate` | `image_generation`, `reference_images` (default `xai/grok-imagine-image-2.0`). |
| Image edit | Stable | Supported | `higgsfield-generate` | `image_edit`; default `alibaba/qwen-image-3/edit`. `mask` and `preserve_identity` are not supported by that model. |
| Video | Stable | Supported | `higgsfield-generate` | Text-to-video, image-to-video (start/end frame), and reference-to-video across the Kling and Seedance endpoints. |
| Soul ID | Stable (training only) | Supported | `higgsfield-soul-id` (partial) | Custom-reference training is available through `higgsfield.generate` with `endpoint: "soul-id"`. Identity generation is not: no consumer of `custom_reference_id` is in the catalog. |
| Product shoot | Not implemented | Not exposed | `higgsfield-product-photoshoot` (unsupported) | Depends on a backend prompt enhancer and `gpt_image_2`, neither of which is documented. |
| Agent API | Disabled | Preview | none | `HF_MCP_EXPERIMENTAL_AGENT_API` defaults to `false`; no Agent API code path exists in this repository. |
| Websites | Out of scope | CLI-specific workflow | `higgsfield-websites` (excluded) | A deployment/runtime surface, not media generation (SPEC §26, §70). |

## Skill status

From `skills/manifest.json`, pinned to `higgsfield-ai/skills@f83af0bc1d937c8119099a11f8ebbf5e6fb99819`
(upstream `0.13.0`, adapter `0.1.0`):

| Skill | Status | Workflows | Reason (abbreviated) |
|---|---|---|---|
| `higgsfield-generate` | compatible | image-generation, image-edit, text-to-video, image-to-video, reference-to-video | Generation workflows map onto catalog endpoints; unsupported sub-features are marked unavailable in the skill instead of being simulated. |
| `higgsfield-soul-id` | partial | soul-character-training | Training works end to end; identity generation has no catalog consumer, and soul listing/style presets have no MCP tool. |
| `higgsfield-product-photoshoot` | unsupported | — | Hidden backend prompt enhancer holds the mode-specific vocabulary; the required model is absent from the catalog. |
| `higgsfield-brandkit` | unsupported | — | Needs a remote PPTX template, host tooling (Python, Chromium, ImageMagick, LibreOffice, Poppler), and models absent from the catalog. |
| `higgsfield-marketplace-cards` | unsupported | — | Backend-owned compliance templates and a model id absent from the catalog. |
| `higgsfield-websites` | excluded | — | Out of scope (SPEC §26, §70). |
| `higgsfield-video-explainer` | unsupported | — | Needs a server-side preset catalog and assembler plus models absent from the catalog. |
| `higgsfield-youtube-thumbnail` | unsupported | — | Needs three endpoints that do not exist in the catalog and an HTML-canvas environment. |

See [skills.md](skills.md) for the full reasoning and the pinning workflow.

## Execution manifest (what this gateway may run)

`packages/provider-higgsfield/src/models/registry.json`, `catalogVersion` `2026-10-02.1`,
`asOf` `2026-10-02`. This file is the *execution* manifest: routing defaults, input
validation, provider defaults, pricing overrides and the endpoint allowlist are all derived
from it, and only these endpoints can be submitted.

| Model id | Type | Status | Endpoint | Capabilities |
|---|---|---|---|---|
| `xai/grok-imagine-image-2.0` | image | active | `xai/grok-imagine-image-2.0` | image_generation, image_edit, reference_images |
| `alibaba/qwen-image-3/edit` | image | active | `alibaba/qwen-image-3/edit` | image_edit, reference_images |
| `kling-video/v2.5-turbo/pro/text-to-video` | video | active | `kling-video/v2.5-turbo/pro/text-to-video` | text_to_video |
| `kling-video/v2.5-turbo/pro/image-to-video` | video | active | `kling-video/v2.5-turbo/pro/image-to-video` | image_to_video |
| `bytedance/seedance-2.5/image-to-video` | video | active | `bytedance/seedance-2.5/image-to-video` | image_to_video, end_image, audio_generation |
| `bytedance/seedance-2.5/reference-to-video` | video | active | `bytedance/seedance-2.5/reference-to-video` | reference_to_video, reference_images, audio_generation |
| `soul-id` | image | active | `v1/custom-references` | custom_reference_training, identity_generation |

## Discovered models (what the provider documents)

`higgsfield.models.list`, `higgsfield.models.get` and the `higgsfield://models` resources do
**not** read the manifest. They walk the provider's public documentation directory
(`https://docs.higgsfield.ai/docs/models.md` → category → model family → workflow), so the
surface follows the published catalog without a release: today that is 35 model families and
~83 workflows, an order of magnitude more than the gateway can run.

Each discovered record states its own provenance and its execution verdict:

| Field | Meaning |
|---|---|
| `source.url` / `source.urls` | The canonical documentation page(s) it was read from, plus `fetched_at`. |
| `schema_status` | `available` only when the workflow's `Complete JSON schema` accordion parsed and used local `$ref`s only; otherwise `unavailable` with `schema_reason`. |
| `execution.supported` | `true` only for a production endpoint that is in the execution manifest **and** whose documented schema still matches the manifest's input schema structurally. |
| `execution.reason` | Otherwise why not: `adapter_not_implemented`, `schema_unavailable`, `schema_changed`, `environment_not_supported`, `endpoint_unverified`, `endpoint_conflict`. |
| `availability` / `account_access` | Always `documented` / `unverified`: documentation presence is not account entitlement. |
| `capabilities` | From the execution manifest, or `[]` — never guessed from a name or a schema field. |

`catalog` on every response reports `source_url`, `fetched_at`, `stale`, `total`, `returned`
and bounded `warnings`, so a caller can tell a fresh catalog from a stale one.

Notes:

* Documentation is read lazily on the first discovery call, cached in memory for ten minutes,
  and refreshed single-flight. A refresh failure serves the last complete snapshot (`stale:
  true`) for up to 24 hours; after that, discovery fails with `PROVIDER_ERROR`
  (`details.reason: catalog_unavailable`). Generation, job reconciliation and `tools/list`
  never depend on that site, and discovery never falls back to the bundled manifest while
  claiming to be live.
* Discovery is read-only: it never enables an endpoint, never submits generation and never
  spends. `higgsfield.generate` still refuses any endpoint outside the execution manifest.
* `alibaba/qwen-image-3/text-to-image` and the other endpoints below are documented upstream,
  so they now appear in `higgsfield.models.list` with `execution.supported: false`; they are
  still rejected by `higgsfield.generate`. Endpoints named only in the supplementary
  `openapi.json` are not discovered at all, because that file is explicitly not the
  authoritative catalog.
* `higgsfield-mcp models` prints the same discovered catalog, so the CLI and the MCP surface
  cannot contradict each other.

| Endpoint id | Reported reason |
|---|---|
| `higgsfield-ai/soul/standard` | `adapter_not_implemented`: documented consumer of `custom_reference_id`, but the manifest has no adapter entry. |
| `higgsfield-ai/soul/v2/standard` | Same as above. |
| `alibaba/qwen-image-3/edit` | `schema_changed`: the documented schema now wraps its conditional rule in `allOf`, which the manifest does not mirror; the manifest schema stays the generation contract pending a reviewed adapter update. |
| `v1/custom-references` | `execution.supported: true` under its preserved public id `soul-id`. |

Each execution-manifest entry carries its own source URL and `asOf` date in the registry file.
`higgsfield.generate` accepts only manifest endpoint ids, so a documented-but-unsupported
workflow is unreachable rather than merely unlisted.

## Distribution and runtime

| Surface | Status |
|---|---|
| stdio MCP | Stable; the default command, and what the installed `higgsfield-mcp` runs. |
| Streamable HTTP MCP (`POST /mcp`) | Stable, with bearer authentication required. |
| npm package (`higgsfield-mcp`, `bin.higgsfield-mcp`) | Built and packed by `pnpm --filter higgsfield-mcp pack`; verified self-contained by the distribution profile of the e2e harness. |
| Container image | `Dockerfile` (multi-stage, `node:22-slim` pinned by digest, non-root uid/gid 10001, read-only root with a `/tmp` tmpfs, `STOPSIGNAL SIGTERM`, healthcheck on `/health`). |
| Compose integration stack | `docker-compose.yml` (PostgreSQL + Redis + S3-compatible object store + one-shot migrate/tenants init + gateway). |
| PostgreSQL persistence | Supported; migrations via `higgsfield-mcp migrate`. |
| Redis rate limiting | Supported; fails closed when Redis is unavailable. |
| Managed object storage | Supported (`HF_MCP_ASSET_MODE=managed`); local compose uses a SeaweedFS S3 endpoint. |
| OpenTelemetry traces | Supported (OTLP/HTTP), off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. See the gap note in [observability.md](observability.md). |
| Webhooks | Supported as an untrusted reconciliation hint only; no signature verification is claimed. |
| Multi-tenancy | Supported in remote mode through the tenants file; stdio is a single implicit local tenant. |
