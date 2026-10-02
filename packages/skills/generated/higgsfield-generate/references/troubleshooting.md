# Troubleshooting

## Authentication

Every failure here is a gateway/operator problem, not something this skill can fix by re-authenticating:

- `AUTHENTICATION_FAILED` — the gateway's provider credentials are missing, wrong or expired. Report it; do not ask the user to log in from a skill.
- `PERMISSION_DENIED` / a scope error — the client's token lacks `higgsfield:generate` or `higgsfield:upload`. Report which scope is missing.

## Validation

- `INVALID_INPUT` with `missing required` — a required field was omitted (usually `prompt`, `image` or `start_image`). Ask for it.
- `Invalid values: … (allowed: …)` — the value is outside the endpoint's closed set. Pick from the allowed list; the gateway never clamps silently.
- `Unknown params: <name>` — the endpoint's schema does not declare that field. Check `higgsfield.models.get` and drop it.
- `Model <id> has no documented equivalent for <feature>` — you asked for a capability that endpoint does not have (`count > 1`, `width`, `style`, an unsupported media role). Choose a different endpoint or drop the feature.

## Job lifecycle

- A job with `status: "failed"` carries a provider detail; often content policy or a prompt problem. Rephrase; do not silently resubmit.
- A `higgsfield.jobs.wait` that returns a still-running job is normal: the gateway caps one wait at `higgsfield.capabilities.limits.max_wait_ms` (25 s shipped, 20 s default) and ignores a larger `timeout_ms` — `timeout_ms: 0` returns the current state immediately instead of waiting. Poll again or read `higgsfield.jobs.get`.
- `jobs.cancel` only reports a cancellation the provider accepted. If it reports `accepted: false`, the job is still running.
- Long jobs do not depend on one open request: a job survives a gateway restart, and `higgsfield.jobs.list` finds it again.

## Rate limits and retries

`RATE_LIMITED` (or any error with `retryable: true`) — wait `retry_after_ms`, then retry the identical call with the same `idempotency_key`. A retry with a fresh idempotency key can submit the work twice.

## Cost

The skill never guesses a price. A submission that crosses the gateway's cost threshold answers `status: "confirmation_required"` with `estimated_cost_usd`, `confirmation_token` and `expires_at`. Show the estimate, get the user's approval, then re-submit the identical call with `confirmation_token`. An expired token means starting over, not auto-approving.
