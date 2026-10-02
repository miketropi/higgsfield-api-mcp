## Workflow — train the Soul

1. **Get the name.** One word, used for later reference. Ask if missing.
2. **Get the photos.** 5–20 face photos, varied angles and lighting (`references/photo-guide.md`). Upload each one with `higgsfield.media.upload`; keep the returned `asset_id`s in the order you want them trained.
3. **Pick the variant.** The endpoint's `model_version` carries the upstream variant choice — state which one you submit:

   | Upstream variant | `model_version` | Use for |
   |---|---|---|
   | Soul 2 (`--soul-2`, the upstream default) | `"v2"` | Image generation (default) |
   | Soul Cinema (`--soul-cinematic`) | `"cinema"` | Cinematic / video work |
   | — (endpoint default) | `"v1"` | Leave the endpoint's documented default in place |

   Choose from the user's stated downstream use and default to `"v2"`, matching the upstream default. Name the version in your summary so nothing is implicit.

4. **Upload → resolve → approve → submit.** The endpoint takes `input_images` entries of `{ "type": "image_url", "image_url": "…" }`, so resolve each `asset_id` with `higgsfield.media.get` first:

   ```json
   { "tool": "higgsfield.media.get", "arguments": { "asset_id": "<asset_id>" } }
   ```

   Training is billable: say what will train (name, `model_version`, photo count) and get the user's approval before the submission. If the result of the submission is `status: "confirmation_required"`, show `estimated_cost_usd` and re-submit the identical call with `confirmation_token` only after they agree.

   ```json
   { "tool": "higgsfield.generate",
     "arguments": {
       "endpoint": "v1/custom-references",
       "input": {
         "name": "<name>",
         "model_version": "v2",
         "input_images": [
           { "type": "image_url", "image_url": "<url from higgsfield.media.get>" }
         ]
       } } }
   ```

   `v1/custom-references` is the catalog endpoint id for `soul-id`; confirm it with `higgsfield.models.get` before submitting.

5. **Poll.** Training takes minutes, and the gateway bounds every wait: call `higgsfield.jobs.wait` with `job_id` and a `timeout_ms` no larger than `higgsfield.capabilities.limits.max_wait_ms` (25 s on the shipped gateway; 20 s when omitted — larger values are clamped, and `timeout_ms: 0` returns the current state immediately rather than waiting). A returned still-running job is the normal case, not a failure: call `higgsfield.jobs.get` (or `wait` again) until the status is terminal. Poll silently and do not narrate each status.
6. **Deliver.** The finished job carries `metadata.custom_reference_id` — that is the trained reference. Tell the user "Soul `<name>` ready" and keep the reference id; it is the handle for anything downstream that can consume a trained identity.
