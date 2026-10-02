## Errors

Gateway failures come back as a structured error envelope: `{ "error": { "code", "message", "retryable", "retry_after_ms", "details" } }`. Map them like this:

- `INVALID_INPUT` — a parameter or a role the endpoint does not declare. Read the message, check `higgsfield.models.get`, fix the call. Do not retry unchanged.
- `MODEL_NOT_FOUND` / `MODEL_UNAVAILABLE` — the id is not in the catalog, or it cannot perform the capability you asked for. Read `higgsfield.models.list` and offer a catalog model, or state that the workflow is unavailable.
- `confirmation_required` (a result, not an error) — the call needs approval: show `estimated_cost_usd`, wait for the user, re-submit with `confirmation_token`.
- `RATE_LIMITED` / `retryable: true` — back off for `retry_after_ms` and retry the identical call with the same `idempotency_key`.
- `PROVIDER_ERROR` — the provider side failed. Retry once; if it persists, report it and stop.
- `AUTHENTICATION_FAILED` — the gateway's provider credentials are wrong or expired. That is an operator problem, not something to fix by re-authenticating from the skill.
- `REQUEST_TIMEOUT` — a long job did not finish inside the bounded wait window (`higgsfield.jobs.wait` is clamped to `capabilities.limits.max_wait_ms`). Nothing was cancelled: poll `higgsfield.jobs.get` or call `higgsfield.jobs.wait` again. A still-running job is not a failure.
- A content-policy rejection surfaces as a failed job (`status: "failed"` with a provider detail). Rephrase the prompt; do not silently retry.

A wait that returns a still-running job is not a failure — it is the gateway refusing to hold one request open indefinitely.
