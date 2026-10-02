Submit generation jobs to the Higgsfield models that the MCP gateway exposes. Covers generic image generation, image editing, text-to-video, image-to-video and reference-to-video through the `higgsfield.*` MCP tools — no Higgsfield CLI, no installer, no login step.

The gateway resolves the provider endpoint for you. Use the semantic tools (`higgsfield.generate_image`, `higgsfield.edit_image`, `higgsfield.generate_video`, `higgsfield.animate_image`) unless you need to name a provider endpoint explicitly, in which case use `higgsfield.generate` with an `endpoint` from `higgsfield.models.list`.

## Before you spend

Every generation call is billable and every one of them needs the user's approval first.

1. Say what will run: the model the gateway will use (or the semantic route), the prompt, the aspect ratio / resolution / duration, the count, and which reference assets are attached.
2. Ask the user to confirm — unless this turn's request already stated exactly that work.
3. If the tool answers `status: "confirmation_required"`, show `estimated_cost_usd` and stop. Re-submit the identical call with `confirmation_token` only after the user approves. Never auto-approve.
4. Approval gates spending only. `higgsfield.capabilities`, `higgsfield.models.list`, `higgsfield.models.get`, `higgsfield.media.upload` of user-supplied files, `higgsfield.media.get` and the `higgsfield.jobs.*` readers need no approval.

## Execution trace

The ordered MCP calls for a generic image task and the video follow-up that chains off it. `gate: approval` marks a checkpoint that must precede the next spending call; `chained_from` marks the asset that flows into the next call (`asset_id` from `higgsfield.media.upload` or `higgsfield.media.get`).

```json
{
  "skill": "higgsfield-generate",
  "steps": [
    { "id": "discover-gateway", "tool": "higgsfield.capabilities", "purpose": "Learn the gateway version, capabilities and request limits." },
    { "id": "list-models", "tool": "higgsfield.models.list", "purpose": "Read the reachable catalog before choosing anything." },
    { "id": "read-model", "tool": "higgsfield.models.get", "purpose": "Inspect the declared input schema, limits and defaults of the chosen model." },
    { "id": "upload-reference", "tool": "higgsfield.media.upload", "purpose": "Upload a user-supplied local file or public URL; returns asset_id." },
    { "id": "approve-image", "gate": "approval", "purpose": "Show the model, prompt, parameters and estimate; wait for the user." },
    { "id": "generate-image", "tool": "higgsfield.generate_image", "chained_from": { "step": "upload-reference", "field": "asset_id" }, "purpose": "Submit the image job." },
    { "id": "await-image", "tool": "higgsfield.jobs.wait", "purpose": "Poll within the gateway's bounded wait window (<= capabilities.limits.max_wait_ms); a still-running job means poll again." },
    { "id": "read-asset", "tool": "higgsfield.media.get", "chained_from": { "step": "await-image", "field": "asset_id" }, "purpose": "Resolve the produced asset_id to a fetchable asset reference." },
    { "id": "approve-video", "gate": "approval", "purpose": "Show the video model, duration and estimate; wait for the user." },
    { "id": "generate-video", "tool": "higgsfield.generate_video", "chained_from": { "step": "read-asset", "field": "asset_id" }, "purpose": "Animate the generated image; the gateway picks the image-to-video endpoint from the inputs." },
    { "id": "await-video", "tool": "higgsfield.jobs.wait", "purpose": "Poll within the bounded wait window; repeat until the video job is terminal." }
  ],
  "routing": [
    { "request": "product-photoshoot", "outcome": "unavailable", "reason": "The upstream product-photoshoot workflow is a thin client over an undocumented backend prompt enhancer that owns its mode vocabulary and templates. No catalog endpoint reproduces it, so there is no MCP equivalent." },
    { "request": "marketplace-cards", "outcome": "unavailable", "reason": "Marketplace compliance rules and templates are held privately by the upstream backend enhancer; the model it submits to is not in the catalog." },
    { "request": "brandkit", "outcome": "unavailable", "reason": "Requires the remote canonical brandbook template plus host tooling (Python, Chromium, ImageMagick, LibreOffice) and models outside the catalog." },
    { "request": "video-explainer", "outcome": "unavailable", "reason": "Requires the server-side explainer preset catalog and the server-side assembler; neither is in the catalog." },
    { "request": "youtube-thumbnail", "outcome": "unavailable", "reason": "Requires models absent from the catalog and, for the overlay path, an HTML-canvas environment." },
    { "request": "websites", "outcome": "unavailable", "reason": "Out of scope for the gateway: web/app/game creation, deployment and publishing." },
    { "request": "marketing-studio", "outcome": "unavailable", "reason": "The Marketing Studio models are not in the catalog; its setup libraries, avatar synthesis and ad templates live in the upstream backend." },
    { "request": "virality-predictor", "outcome": "unavailable", "reason": "The video-analysis model that scores hook, attention and retention is not in the catalog." },
    { "request": "3d-asset", "outcome": "unavailable", "reason": "No mesh or GLB-generation endpoint exists in the catalog, so 3D asset creation cannot be submitted." },
    { "request": "audio-generation", "outcome": "unavailable", "reason": "No audio, music or text-to-speech endpoint exists in the catalog, so audio creation cannot be submitted." },
    { "request": "workflow-jobs", "outcome": "unavailable", "reason": "The gateway exposes no workflow-job tool; the upstream workflow commands have no MCP equivalent." }
  ]
}
```

When a request routes to an `unavailable` entry, say so plainly and name the reason. Do not re-route it to an unrelated model and do not describe an uncatalogued model as if it had produced the asset.

## Gateway call shapes

Image generation, optionally with references:

```json
{ "tool": "higgsfield.generate_image",
  "arguments": { "prompt": "neon city at dusk", "aspect_ratio": "16:9", "quality": "high",
                 "reference_images": [{ "type": "asset", "asset_id": "<asset_id>" }] } }
```

Image edit or restyle of an existing image:

```json
{ "tool": "higgsfield.edit_image",
  "arguments": { "prompt": "transform into anime style, vibrant colors, soft cel shading",
                 "image": { "type": "asset", "asset_id": "<asset_id>" },
                 "references": [{ "type": "asset", "asset_id": "<asset_id>" }] } }
```

Video (text-to-video, image-to-video, end-frame transition or reference-to-video — the gateway picks the endpoint that matches the inputs you send):

```json
{ "tool": "higgsfield.generate_video",
  "arguments": { "prompt": "camera dollies in", "duration": 10, "resolution": "720p",
                 "start_image": { "type": "asset", "asset_id": "<asset_id>" } } }
```

Animate a still image:

```json
{ "tool": "higgsfield.animate_image",
  "arguments": { "prompt": "slow push in", "image": { "type": "asset", "asset_id": "<asset_id>" } } }
```

Provider-native call (only when a specific catalog endpoint must be named):

```json
{ "tool": "higgsfield.generate",
  "arguments": { "endpoint": "bytedance/seedance-2.5/image-to-video",
                 "input": { "prompt": "waves break on a grey shore",
                            "image_url": "<https url from higgsfield.media.get>" } } }
```

Every tool returns a job object immediately unless `wait: true`; `higgsfield.jobs.wait` blocks for a bounded window (default 20 s, clamped to `higgsfield.capabilities.limits.max_wait_ms`, 25 s on the shipped gateway), and a returned still-running job is simply polled again with `higgsfield.jobs.get` or another `wait`. `timeout_ms: 0` reads the current state and returns immediately — it does not wait forever.
