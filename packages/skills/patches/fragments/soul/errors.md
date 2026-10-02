## Errors

Gateway failures arrive as `{ "error": { "code", "message", "retryable", "retry_after_ms", "details" } }`.

- A plan or entitlement rejection — training needs a paid Higgsfield plan (Basic or higher). Tell the user; do not retry hoping for a different answer.
- `Training failed` / a failed job with a provider detail — the photos are the usual cause: fewer than five, one repeated pose, heavy occlusion (sunglasses, hats), group shots, or a non-image upload. Swap in better photos and retrain.
- `AUTHENTICATION_FAILED` — the gateway's provider credentials are wrong or expired. That is an operator problem, not something to fix from the skill.
- `INVALID_INPUT` — the endpoint requires `name` and at least one `input_images` entry, and rejects unknown fields. Check `higgsfield.models.get` for `soul-id`.
- `REQUEST_TIMEOUT` / a still-running job after `higgsfield.jobs.wait` — expected: training takes minutes and the wait is bounded by `capabilities.limits.max_wait_ms`. Poll again with `higgsfield.jobs.get` (or `wait`) until the status is terminal. The job keeps running in the background, and `higgsfield.jobs.list` finds it again after a reconnect.
- `RATE_LIMITED` — back off `retry_after_ms`, then retry the identical call with the same `idempotency_key` so a retry cannot train twice.
