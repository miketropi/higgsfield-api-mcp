# Media Inputs

How the gateway passes reference images, videos and audio into generation, and how generated media is chained into the next call. This is the MCP contract; the upstream flag vocabulary (`--image`, `--start-image`, …) does not exist here.

## Reference shapes

Every reference-media field accepts the same three forms:

```json
{ "type": "asset", "asset_id": "<asset_id from higgsfield.media.upload>" }
{ "type": "url", "url": "https://example.com/photo.png" }
{ "type": "file", "path": "./photo.png" }
```

- Prefer `type: "asset"`. `higgsfield.media.upload` returns an `asset_id`, and an asset reference survives signed-URL expiry.
- `type: "url"` requires a public HTTPS URL the provider can fetch directly.
- `type: "file"` is stdio-only: it reads a path on the gateway host. Over HTTP transport it is rejected.

Upload first, then reference:

```json
{ "tool": "higgsfield.media.upload", "arguments": { "source": { "path": "./photo.png" }, "media_type": "image" } }
```

```json
{ "tool": "higgsfield.media.get", "arguments": { "asset_id": "<asset_id>" } }
```

`higgsfield.media.get` returns `url`, `media_type`, `mime_type`, size, dimensions, `duration_seconds` when applicable, `created_at` and `expires_at`. Use it to (a) hand a fetchable URL to a provider-native call and (b) verify the asset before spending on it.

## Roles by tool

| Tool field | Use |
|---|---|
| `reference_images: [...]` on `higgsfield.generate_image` | Reference images for a generation. The catalog model declares up to 10. |
| `image` on `higgsfield.edit_image` / `higgsfield.animate_image` | The image being edited or animated. Exactly one. |
| `references: [...]` on `higgsfield.edit_image` | Ordered context images for an edit (up to three). |
| `start_image` on `higgsfield.generate_video` / `higgsfield.animate_image` | First frame of an image-to-video transition. |
| `end_image` on `higgsfield.generate_video` | Last frame; sending it selects the start-frame + end-frame endpoint. |
| `references: [...]` on `higgsfield.generate_video` | Reference-to-video set; sending it selects the reference-to-video endpoint. |

The gateway picks the video endpoint from the inputs you send: text only → text-to-video, `start_image` → image-to-video, `end_image` → the end-frame endpoint, `references` → reference-to-video. Name a provider endpoint explicitly with `higgsfield.generate` only when you need to bypass that decision.

## Chaining

Generated media comes back on the job object as an asset (`assets[]` with `asset_id`). Chain by id, not by re-describing:

```json
{ "tool": "higgsfield.jobs.wait", "arguments": { "job_id": "<job_id>", "timeout_ms": 20000 } }
```

A wait is bounded by the gateway: `timeout_ms` is clamped to `higgsfield.capabilities.limits.max_wait_ms` (25 s on the shipped gateway, 20 s when omitted), so a value above the bound buys nothing. A returned still-running job is normal — repeat with `higgsfield.jobs.get` until the status is terminal. `timeout_ms: 0` means "return the current state now", not "wait indefinitely".

```json
{ "tool": "higgsfield.generate_video",
  "arguments": { "prompt": "slow push in", "duration": 5,
                 "start_image": { "type": "asset", "asset_id": "<asset_id from the finished image job>" } } }
```

## Schema mismatches

- A role the endpoint does not declare is rejected: `Model <id> has no documented equivalent for <feature>`. Check `higgsfield.models.get` for the endpoint's declared fields.
- An unknown field is rejected too — the request body is validated against the endpoint's published JSON schema.
- The single-frame endpoints take exactly one `image`/`image_url`; multiple images belong in `reference_images` / `references` / `image_urls`.
- A missing required field fails at submission: `Request parameters do not match the documented schema for <id>`. Fix the call; do not retry it unchanged.

## Seeing what an endpoint accepts

```json
{ "tool": "higgsfield.models.get", "arguments": { "model": "<id from higgsfield.models.list>" } }
```

The response carries the endpoint's `limits`, `input_schema` and documented defaults — aspect ratios, durations, resolutions and media fields, exactly as the gateway will validate them.
