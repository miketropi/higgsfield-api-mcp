# Skills

A *skill* here is an upstream `SKILL.md` bundle from `higgsfield-ai/skills` that has been
adapted to drive the gateway over MCP instead of the Higgsfield CLI. `packages/skills` is the
adapter: it pins the upstream revision, patches the documents deterministically, records a
hash for every upstream file it read, and validates that each shipped skill only names tools
and endpoints this gateway actually has.

The gateway never executes a skill. Skills are instructions for the agent; the gateway
provides the MCP tools they call.

## Layout

```
skills/                     # the generated tree the gateway resolves and the image packages
  manifest.json             # pin + per-skill classification (checked in)
  higgsfield-generate/
    SKILL.md
    references/…

packages/skills/
  source/                   # the pinned upstream checkout (input to sync)
  patches/fragments/        # deterministic patch rules (input to sync)
  generated/                # local output of `pnpm skills:sync`
  manifest.json             # identical to skills/manifest.json
  src/                      # manifest, patch, sync, validate, check-upstream, CLI
```

`pnpm skills:sync` regenerates `packages/skills/generated/`; the reviewed copy is promoted to
`skills/`. The container image copies `skills/` (falling back to
`packages/skills/generated/`) to `apps/server/dist/skills`, which is the first location
`apps/server/src/skills-dir.ts` probes.

## Upstream pin

| Field | Value |
|---|---|
| Repository | `higgsfield-ai/skills` |
| Commit | `f83af0bc1d937c8119099a11f8ebbf5e6fb99819` |
| Upstream version | `0.13.0` |
| Adapter version | `0.1.0` |

The manifest schema requires a fully immutable 40-character commit SHA; a branch or tag is not
accepted. Every entry also carries `sourceHashes`: the lowercase hex SHA-256 of each upstream
file the adapter read, so drift in a pinned file is detectable.

## Classification

`status` is one of:

- **`compatible`** — the workflows run end to end through MCP tools and catalog endpoints.
- **`partial`** — some workflows work; the rest are documented as unavailable inside the
  generated skill.
- **`unsupported`** — no workflow can be reproduced through MCP, with a reason.
- **`excluded`** — deliberately out of scope.

The manifest enforces coherence: a `compatible` or `partial` skill must declare its workflows
and required tools, and an `unsupported` or `excluded` skill must declare neither. Every
shipped skill that names a tool must name one that exists (`KNOWN_TOOLS`).

| Skill | Status | Workflows | Why |
|---|---|---|---|
| `higgsfield-generate` | compatible | image-generation, image-edit, text-to-video, image-to-video, reference-to-video | The public-model generation subset maps onto catalog endpoints: `image.default` → `xai/grok-imagine-image-2.0`, `image.edit` → `alibaba/qwen-image-3/edit`, `video.default` → `kling-video/v2.5-turbo/pro/{text,image}-to-video` and `bytedance/seedance-2.5/{image,reference}-to-video`. Marketing Studio, the Virality Predictor (`brain_activity`), 3D (`multi_image_to_3d`), audio models (`seed_audio`, `sonilo_music`, `mirelo_text_to_audio`), workflow jobs (`draw_to_video`, `reframe`), and every model id outside the catalog are marked unavailable in the generated skill instead of being simulated. |
| `higgsfield-soul-id` | partial | soul-character-training | Training works: upload 5–20 photos with `higgsfield.media.upload`, submit `name` / `model_version` / `input_images` to the `soul-id` custom-reference endpoint through `higgsfield.generate`, poll with `higgsfield.jobs.wait`, and read `metadata.custom_reference_id`. Identity generation does not: every documented consumer of `custom_reference_id` (`higgsfield-ai/soul/standard`, `higgsfield-ai/soul/v2/standard`, `text2image_soul_v2`, `soul_cinematic`) is absent from the catalog, because the registry excludes those model pages for lack of a parameter schema. Soul listing and style presets have no MCP tool. |
| `higgsfield-product-photoshoot` | unsupported | — | Hidden backend dependency: the CLI calls a backend prompt enhancer that holds the mode-specific photography vocabulary and structural templates, and the skill forbids writing the `gpt_image_2` prompt yourself. `gpt_image_2` is not in the catalog and the enhancer has no documented API. |
| `higgsfield-brandkit` | unsupported | — | Requires the remote canonical Brandbook PPTX template plus host tooling (python3, Playwright/Chromium, ImageMagick, rsvg-convert, LibreOffice, Poppler) and the `recraft_v4_1` / `seedream_v5_pro` / `gpt_image_2` models, none of which exist in the catalog. The local deterministic brandkit scripts are Python, not MCP. |
| `higgsfield-marketplace-cards` | unsupported | — | Hidden backend dependency: the backend owns the marketplace compliance references and prompt templates and creates `nano_banana_2` jobs. Private templates plus a model id absent from the catalog cannot be mapped. |
| `higgsfield-websites` | excluded | — | Out of scope per SPEC §26 and §70: a deployment/runtime surface (website/app/game create, deploy and publish against live infrastructure, Cloudflare Workers, git/bun, Meshy, a bundled GLB pipeline) rather than media generation through the provider catalog. |
| `higgsfield-video-explainer` | unsupported | — | Requires the server-side explainer preset catalog and the `explainer_video` assembler plus the `nano_banana_2` / `seed_audio` / `gemini_omni` models; none is in the catalog, and the skill's own MCP mapping table names operations that are not implemented here. |
| `higgsfield-youtube-thumbnail` | unsupported | — | The main render needs `nano_banana_pro`, focused edits need `seedream_v5_pro`, and the optional 3D logo/text overlay needs `gpt_image_2` plus an HTML-canvas environment. None of those endpoints exists in the catalog. |

## Commands

Root scripts (delegate to the skills package):

| Command | Effect |
|---|---|
| `pnpm skills:sync` | Regenerate the skills tree from the pinned upstream into `packages/skills/generated/`. Needs network access. |
| `pnpm skills:validate` | Validate the generated tree against the bundled model catalog and the known tool set. |
| `pnpm skills:check-upstream` | Compare the pin with the upstream head and report drift. |

CLI equivalents (`apps/server/src/cli.ts`):

| Command | Effect |
|---|---|
| `higgsfield-mcp skills list` | Print `upstream: <repo>@<commit>`, the upstream and adapter versions, then one line per skill: `name`, `status`, optional `workflows=…`, and the reason. Without a resolved tree it prints `skills: no generated skills tree found (set HF_MCP_SKILLS_DIR or run pnpm skills:sync)` and exits 0. |
| `higgsfield-mcp skills sync [--upstream <url>]` | Run the same sync as the root script; `--upstream` overrides the source URL. |
| `higgsfield-mcp skills check-upstream` | Print `pinned <commit> / upstream <head> (v<version>) -> drifted|in sync`; exits non-zero when drifted, which is what the scheduled workflow keys on. |
| `higgsfield-mcp skills validate` | Validate on demand; prints `warn` lines, `FAIL` lines, and a summary, exiting non-zero when any error is found. |

Validation checks the generated documents against reality: every tool a skill names must be a
known MCP tool, and every endpoint a skill names must exist in the model catalog, so a skill
cannot silently reference an endpoint the gateway cannot call. A scheduled workflow
(`.github/workflows/skills-drift.yml`) runs the upstream check and opens a compatibility PR
without auto-merging.

## Resolution order

`apps/server/src/skills-dir.ts` resolves the tree as: `HF_MCP_SKILLS_DIR` (resolved against the
working directory), then `<dist>/skills`, then `<dist>/../skills`, then `<cwd>/skills`. The
first directory containing a `manifest.json` wins. `higgsfield://capabilities` reports
`skills_version` as `<adapterVersion>+upstream.<version>` (for example
`0.1.0+upstream.0.13.0`), or `unavailable` when no tree resolves.
