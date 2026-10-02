## Step 0 — Discovery (MCP)

This skill runs through the Higgsfield MCP gateway. There is nothing to install and nothing to log in to: the agent host supplies the gateway, and the gateway holds the provider credentials.

Before any generation call:

1. `higgsfield.capabilities` once per session — gateway version, advertised capabilities, request limits.
2. `higgsfield.models.list` — the reachable catalog. This is the only source of truth for what can run; never reach for a model from memory.
3. `higgsfield.models.get` — the declared input schema, limits and defaults of the model you picked, when you are unsure about a parameter.
4. `higgsfield.media.upload` — user-supplied media, before it is referenced. It accepts a local file path (stdio mode) or a public HTTPS URL and returns an `asset_id`.

A model that is absent from `higgsfield.models.list` cannot be used. Say so and offer the catalog's model for that intent instead of naming the missing one.
