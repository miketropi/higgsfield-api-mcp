> **Gateway first.** This document is the upstream Higgsfield catalog with the gateway mapping applied.
> Only the models in the *Gateway mapping* table are reachable through the MCP gateway. Every other entry
> is kept for **intent guidance only**: it tells you what the upstream surface used for a given brief.
> When a brief maps to an upstream-only model, say that model is unavailable and offer the mapped catalog
> entry — never claim the upstream model ran, and never present a substitution as the model the user named.

## Gateway mapping

| Brief | Gateway tool | Route or endpoint | Upstream default it replaces | How to be honest about it |
|---|---|---|---|---|
| Text-to-image, design, banners, typography, on-image text | `higgsfield.generate_image` | `image.default` → `xai/grok-imagine-image-2.0` (Grok Imagine 2.0) | `gpt_image_2_5` (GPT Image 2.5), `nano_banana_flash`, `seedream_v5_pro`, `recraft_v4_1`, `z_image`, the Soul image models | Name the model that actually ran. If the user asked for GPT Image 2.5, say it is not in the catalog and that the catalog's image model is Grok Imagine 2.0. |
| Image edit, restyle, remix, reference-guided edit | `higgsfield.edit_image` | `image.edit` → `alibaba/qwen-image-3/edit` (Qwen Image 3 Edit) | the same upstream image models | Same rule: state the substitution. |
| Text-to-video | `higgsfield.generate_video` (text only) | `video.default` → `kling-video/v2.5-turbo/pro/text-to-video` | `seedance_2_5`, `kling3_0`, `veo3*`, `grok_video_v15` | Name Kling 2.5 Turbo Pro as the model that ran. |
| Image-to-video / animate a still | `higgsfield.animate_image` or `higgsfield.generate_video` with `start_image` | `video.image_to_video` → `kling-video/v2.5-turbo/pro/image-to-video` | `seedance_2_5` `omni_reference`, `kling3_0_turbo`, `veo3` | Name Kling 2.5 Turbo Pro. |
| Start-frame + end-frame transition | `higgsfield.generate_video` with `end_image` | `bytedance/seedance-2.5/image-to-video` | `seedance_2_5` with an end frame | Name Seedance 2.5. Duration, resolution (`480p`/`720p`/`1080p`) and audio are declarable. |
| Reference-driven video | `higgsfield.generate_video` with `references` | `video.reference_to_video` → `bytedance/seedance-2.5/reference-to-video` | `seedance_2_5` `omni_reference`, `gemini_omni` | Name Seedance 2.5. Accepts image, video and audio references. |
| Train a reusable face identity | `higgsfield.generate` | `v1/custom-references` | `soul-id create` | See `higgsfield-soul-id`. Using the trained identity for generation is unavailable. |
| Marketing Studio ads, UGC, unboxing, presenter, product demos | — | unavailable | `marketing_studio_video`, `marketing_studio_image` | State the workflow is unavailable and why. |
| Virality Predictor video scoring | — | unavailable | `brain_activity` | State the workflow is unavailable. |
| 3D mesh / GLB from reference images | — | unavailable | `multi_image_to_3d` | State the workflow is unavailable. |
| Audio, SFX, music, TTS | — | unavailable | `seed_audio`, `sonilo_music`, `mirelo_text_to_audio` | State the workflow is unavailable. |
| Workflow jobs (draw-to-video, reframe) | — | unavailable | `draw_to_video`, `reframe` | State the workflow is unavailable. |
| Soul style presets | — | unavailable | `style_id` presets | State the workflow is unavailable. |

Catalog ids are the `id` values reported by `higgsfield.models.list`; the `endpoint` column is what `higgsfield.generate` accepts. Semantic routes (`image.default`, `image.edit`, `video.default`, `video.image_to_video`, `video.reference_to_video`) are resolved by the gateway to the endpoint above.

---

Everything below this line is the upstream catalog, kept verbatim for intent guidance. Read it to understand *what the upstream surface used for a brief*, then check the mapping table above before you say a model will run.
