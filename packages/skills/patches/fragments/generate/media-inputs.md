## Media flags → MCP media references

Every reference-media field takes the same three forms:

| MCP reference | Use |
|---|---|
| `{ "type": "asset", "asset_id": "<id>" }` | An upload from `higgsfield.media.upload`, or an asset id returned by `higgsfield.media.get` / a finished job. The normal path. |
| `{ "type": "url", "url": "https://…" }` | A public HTTPS URL the provider can fetch. |
| `{ "type": "file", "path": "./photo.png" }` | A local path, stdio transport only. |

Role names by tool:

| Role | Tool field | Meaning |
|---|---|---|
| reference image | `reference_images: [...]` (`higgsfield.generate_image`) | Input images for generation or style guidance. |
| edit source | `image` (`higgsfield.edit_image`, `higgsfield.animate_image`) | The image being edited or animated. |
| start frame | `start_image` (`higgsfield.generate_video`, `higgsfield.animate_image`) | First frame of an image-to-video transition. |
| end frame | `end_image` (`higgsfield.generate_video`) | Last frame of a transition; the gateway switches to the end-frame endpoint. |
| reference set | `references: [...]` (`higgsfield.generate_video`) | Reference-to-video; the gateway switches to the reference endpoint. |

Rules the gateway enforces for you, so answer them in the skill instead of at submission time:

- Upload before you reference. A local path must go through `higgsfield.media.upload` when the transport has no filesystem access for the gateway; the returned `asset_id` is what the next call carries.
- Chain by `asset_id`, never by re-describing the asset. `higgsfield.media.get` turns an `asset_id` into a fetchable asset reference (`url`, `media_type`, `mime_type`, dimensions, `expires_at`).
- Prefer `type: "asset"` over pasting a signed URL: asset references survive URL expiry.
- The gateway rejects a role the selected endpoint does not declare (`Model … has no documented equivalent for …`) and rejects media whose type the endpoint does not accept. Check `higgsfield.models.get` rather than retrying blindly.
- Only one `image`-style input is accepted by the single-frame endpoints; multiple references go through `reference_images` / `references`.
