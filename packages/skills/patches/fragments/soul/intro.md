Train a face-faithful identity model and keep its reference id. Reusable across any downstream surface that can consume a trained Higgsfield identity.

## What this skill can and cannot do

| Workflow | Status | Why |
|---|---|---|
| `soul-character-training` — create a custom character reference from 5–20 photos | **available** | The catalog exposes the `soul-id` endpoint (`v1/custom-references`) with the `custom_reference_training` capability. |
| `identity-generation` — use the trained reference in image or video generation | **unavailable** | Every documented consumer of `custom_reference_id` (`higgsfield-ai/soul/standard`, `higgsfield-ai/soul/v2/standard`, and the Soul image/video models) is absent from the catalog; the registry excludes the soul model pages rather than guessing their parameter schema. |
| `soul-listing` — list or fetch trained Souls | **unavailable** | The gateway exposes no custom-reference listing tool. |
| `soul-style-presets` — browse curated Soul styles | **unavailable** | No MCP tool exposes the preset catalog. |

Availability of training does **not** imply availability of use. When a user asks to generate an image or video of a trained Soul, answer that identity generation is unavailable through the gateway and name the reason — do not substitute a generic model and do not imply the identity was applied.

## Execution trace

Ordered MCP calls for the supported workflow. `gate: approval` marks the checkpoint that must precede the spending call; `chained_from` marks the asset that flows into the next call.

```json
{
  "skill": "higgsfield-soul-id",
  "steps": [
    { "id": "discover-gateway", "tool": "higgsfield.capabilities", "purpose": "Confirm the gateway and read its advertised capabilities and limits." },
    { "id": "read-endpoint", "tool": "higgsfield.models.get", "purpose": "Read the soul-id endpoint schema, limits and documented default model_version." },
    { "id": "upload-photos", "tool": "higgsfield.media.upload", "purpose": "Upload each of the 5–20 face photos; returns one asset_id per photo." },
    { "id": "resolve-photos", "tool": "higgsfield.media.get", "chained_from": { "step": "upload-photos", "field": "asset_id" }, "purpose": "Resolve each asset_id to the image URL the training endpoint requires." },
    { "id": "approve-training", "gate": "approval", "purpose": "Show the name, model_version, photo count and estimate; wait for the user." },
    { "id": "train", "tool": "higgsfield.generate", "chained_from": { "step": "resolve-photos", "field": "asset_id" }, "purpose": "Submit the custom-reference training job to v1/custom-references." },
    { "id": "await-training", "tool": "higgsfield.jobs.wait", "purpose": "Poll within the gateway's bounded wait window; training takes minutes, so the still-running job is polled again." },
    { "id": "read-reference", "tool": "higgsfield.jobs.get", "purpose": "Read metadata.custom_reference_id from the finished job." }
  ],
  "routing": [
    { "request": "identity-generation", "outcome": "unavailable", "reason": "No catalog endpoint consumes a trained custom_reference_id; the Soul generation models are excluded from the registry for lack of a documented parameter schema." },
    { "request": "soul-listing", "outcome": "unavailable", "reason": "The gateway exposes no tool that lists or fetches custom references." },
    { "request": "soul-style-presets", "outcome": "unavailable", "reason": "The curated style preset catalog is not exposed through an MCP tool." }
  ]
}
```
