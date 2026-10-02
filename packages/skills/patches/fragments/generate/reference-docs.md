## Reference docs

Load on demand:

- `references/model-catalog.md` — the gateway catalog mapping plus the upstream picking guidance
- `references/media-inputs.md` — reference media, roles and `asset_id` chaining
- `references/prompt-engineering.md` — writing prompts that work
- `references/troubleshooting.md` — gateway errors and fixes

Upstream reference documents deliberately **not** carried into this tree, because the workflow they document cannot run through the gateway:

| Removed upstream document | Why it is not here |
|---|---|
| workflows.md | Workflow jobs have no MCP tool and no catalog endpoint. |
| marketing-modes.md | Marketing Studio is unavailable end to end. |
| marketing-avatars.md | Marketing Studio avatars are server-side state with no MCP tool. |
| marketing-products.md | Marketing Studio product entities are server-side state with no MCP tool. |
| marketing-setup-items.md | Marketing Studio hooks and settings are server-side state with no MCP tool. |
| marketing-ad-references.md | Marketing Studio ad references are server-side state with no MCP tool. |
| marketing-brand-kits.md | Marketing Studio brand kits are server-side state with no MCP tool. |
| marketing-dtc-ads.md | Marketing Studio ad formats and the DTC ads engine are server-side and unavailable. |

The reasons live in `manifest.json` too: `higgsfield-generate` is `compatible` for the workflow list it names, and every unavailable request above is declared in this skill's execution trace.
