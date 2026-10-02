## Parameters the catalog endpoints actually declare

Call `higgsfield.models.get` for the authoritative schema of the model the gateway selected, then send only the fields it declares. Unknown fields are rejected (`Request parameters do not match the documented schema for …`), not ignored.

| Intent | Semantic tool / route | Declared parameters |
|---|---|---|
| Text-to-image | `higgsfield.generate_image` (`image.default`) | `prompt` (required), `quality` (`draft`\|`standard`\|`high`), `resolution` (`1k`\|`2k`), `aspect_ratio` (`auto`, `1:1`, `1:2`, `2:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`), `reference_images` |
| Image edit | `higgsfield.edit_image` (`image.edit`) | `prompt` + `image` (required), `references`, `seed`, `aspect_ratio` (`1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `7:9`, `9:7`, `9:16`, `16:9`, `21:9`), `negative_prompt` |
| Text-to-video | `higgsfield.generate_video` (`video.default`, text branch) | `prompt` (required), `duration` (`5`\|`10`), `negative_prompt` |
| Image-to-video | `higgsfield.generate_video` with `start_image` (`video.image_to_video`) | `prompt`, `start_image` (required), `duration` (`5`\|`10`) |
| End-frame transition | `higgsfield.generate_video` with `end_image` | `prompt`, `image_url` (required), `end_image_url`, `duration`, `resolution` (`480p`\|`720p`\|`1080p`), `bitrate_mode` (`standard`\|`high`), `generate_audio` |
| Reference-to-video | `higgsfield.generate_video` with `references` (`video.reference_to_video`) | `prompt`, `references`, `duration`, `resolution`, `aspect_ratio` (`16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`), `bitrate_mode`, `generate_audio` |

Notes:

- `quality: "draft"` / `"standard"` on `higgsfield.generate_image` maps to the endpoint's `low` / `medium`; `high` has no documented equivalent on the catalog image model and is rejected rather than silently downgraded.
- `count > 1` is rejected: the catalog image endpoint declares no batch field. Submit separate jobs when the user wants variants.
- `duration` on the video branches is a closed set on the video model the gateway picks; a value outside it is rejected with the allowed list.
- Polling: `higgsfield.jobs.wait` blocks for a bounded window — `timeout_ms` is clamped to `higgsfield.capabilities.limits.max_wait_ms` (25 s on the shipped gateway; 20 s when omitted), and `timeout_ms: 0` returns the current state immediately instead of waiting. A returned still-running job is not a failure: repeat with `higgsfield.jobs.get`, or call `wait` again. `higgsfield.jobs.list` reviews earlier jobs; `higgsfield.jobs.cancel` stops one.
- Costs are not pre-computed by the skill. A call that needs approval returns `status: "confirmation_required"` with `estimated_cost_usd` and a `confirmation_token`; that is the number to show the user.
