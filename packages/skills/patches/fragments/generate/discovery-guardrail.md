## Discovery guardrail

When looking for a Higgsfield feature, do not rely on memory, semantic search or a guessed id. Read the catalog first (`higgsfield.models.list`, then `higgsfield.models.get` for the candidate), and classify a request by task intent and required inputs rather than by the name the user used.

The catalog is small and explicit. Anything the catalog does not list — Marketing Studio, the Virality Predictor video scorer, 3D mesh generation, audio generation, and the upstream workflow jobs — is unavailable, and the honest answer is to say that, not to approximate it with a different endpoint. See the routing table at the top of this skill.

When the user says a model exists and it is not in the catalog, trust the catalog: the gateway can only submit what the catalog declares.
