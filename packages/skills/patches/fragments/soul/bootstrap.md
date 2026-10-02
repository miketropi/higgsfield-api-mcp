## Step 0 — Discovery (MCP)

This skill runs through the Higgsfield MCP gateway. There is nothing to install and no login step: the host supplies the gateway, the gateway holds the credentials.

1. `higgsfield.capabilities` — confirm the gateway is reachable, and read the advertised capabilities and request limits.
2. `higgsfield.models.get` with `soul-id` — the training endpoint's declared schema (`name`, `model_version`, `input_images`), its limits and its documented default.
3. `higgsfield.media.upload` for every photo before submitting — training consumes uploaded assets, never local paths.

Soul training requires a paid Higgsfield plan (Basic or higher). If the provider rejects the submission with a plan or entitlement error, tell the user before retrying anything.
