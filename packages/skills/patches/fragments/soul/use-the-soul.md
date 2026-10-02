## Use the Soul — unavailable

Generating images or video **of** a trained Soul is not available through the gateway.

Why: training returns a `custom_reference_id`, and nothing in the catalog accepts one. The provider's Soul generation models are listed only in the registry's excluded set ("excluded rather than guessed"), and no semantic route resolves a trained identity, so there is no MCP call that applies a Soul to a generation.

What to do instead:

- Say it plainly: "training worked; using a Soul for generation is not available through this gateway."
- Offer a normal image or video generation with the person's likeness described in the prompt or with reference photos supplied as `reference_images` — and say that it is a generic generation, not the trained identity.
- Keep the reference id. If the catalog later exposes a consumer, the id is what it will need.
