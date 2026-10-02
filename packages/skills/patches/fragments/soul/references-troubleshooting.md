# Soul Troubleshooting

## Plan or entitlement rejection

Soul training needs a paid Higgsfield plan. Tell the user to upgrade — the gateway cannot work around it.

## `Training failed`

Common causes:

- Too few photos (<5) or too uniform.
- Heavy occlusion (sunglasses, hats).
- Group photos confusing identity.
- Upload type mismatch (must be image uploads, not video).

Action: ask the user to swap in better photos, then retrain with a new `higgsfield.generate` submission.

## Authentication

A credential failure is a gateway/operator problem (`AUTHENTICATION_FAILED`). Report it; do not ask the user to log in from the skill.

## Slow training

Training runs for minutes — repeated polling is the expected pattern, not one long wait. `higgsfield.jobs.wait` is bounded by the gateway: `timeout_ms` is clamped to `higgsfield.capabilities.limits.max_wait_ms` (25 s on the shipped gateway; 20 s when omitted). When the wait returns a still-running job, call `higgsfield.jobs.get` and repeat until the status is terminal. Never resubmit to hurry it along: a resubmission trains a second, separate reference.
