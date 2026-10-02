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

## Model catalog

`packages/provider-higgsfield/src/models/registry.json`, `catalogVersion` `2026-10-02.1`,
`asOf` `2026-10-02`.

| Model id | Type | Status | Endpoint | Capabilities |
|---|---|---|---|---|
| `xai/grok-imagine-image-2.0` | image | active | `xai/grok-imagine-image-2.0` | image_generation, image_edit, reference_images |
| `alibaba/qwen-image-3/edit` | image | active | `alibaba/qwen-image-3/edit` | image_edit, reference_images |
| `kling-video/v2.5-turbo/pro/text-to-video` | video | active | `kling-video/v2.5-turbo/pro/text-to-video` | text_to_video |
| `kling-video/v2.5-turbo/pro/image-to-video` | video | active | `kling-video/v2.5-turbo/pro/image-to-video` | image_to_video |
| `bytedance/seedance-2.5/image-to-video` | video | active | `bytedance/seedance-2.5/image-to-video` | image_to_video, end_image, audio_generation |
| `bytedance/seedance-2.5/reference-to-video` | video | active | `bytedance/seedance-2.5/reference-to-video` | reference_to_video, reference_images, audio_generation |
| `soul-id` | image | active | `v1/custom-references` | custom_reference_training, identity_generation |

`alibaba/qwen-image-3/text-to-image` is authored as its sibling `…/edit` in the same upstream
page and is not in the catalog.

The catalog is bundled into the CLI at build time; `HF_MCP_EXPERIMENTAL_DYNAMIC_MODELS` is
reserved and does not currently fetch a catalog at run time.

## Deliberately unavailable endpoints

These are named in the upstream API reference but are not exposed, so `higgsfield.models.get`
returns `MODEL_NOT_FOUND` for them (and `higgsfield.models.list` never includes them):

| Endpoint id | Reason |
|---|---|
| `higgsfield-ai/soul/standard` | Listed in the API reference index and a documented consumer of `custom_reference_id`, but the parameter schema was not captured; excluded rather than guessed. |
| `higgsfield-ai/soul/v2/standard` | Same as above. |
| `alibaba/qwen-image-3/text-to-image` | Named as a sibling of `…/edit`; no parameter schema was captured. |
| `kling-video/v2.5-turbo/standard/image-to-video` | Present only in the supplementary `openapi.json`, which is explicitly not the authoritative catalog. |
| `minimax/hailuo-2.3/standard/image-to-video` | Present only in the supplementary `openapi.json`; no authoritative model page schema. |
| `minimax/hailuo-2.3/standard/text-to-video` | Same as above. |

Each entry carries its own source URL and `asOf` date in the registry file. `higgsfield.generate`
accepts only catalog endpoint ids, so these paths are unreachable rather than merely unlisted.

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
