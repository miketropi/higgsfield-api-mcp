# higgsfield-mcp

Production MCP gateway for the Higgsfield generative media API. This package ships the
server binary; the full documentation lives in the repository's `docs/` directory.

```bash
npx -y higgsfield-mcp                # serve MCP over stdio (default)
higgsfield-mcp doctor                # verify configuration and provider reachability
higgsfield-mcp models                # list registered models and their sources
higgsfield-mcp serve --transport http --port 3000
```

Set `HF_API_CREDENTIALS` to `Key <id>:<secret>` (environment only — never a tool argument).
Run `higgsfield-mcp --help`-style commands to introspect: `version`, `models`,
`skills list`, `doctor`, `migrate`, `jobs reconcile`.

Remote mode requires PostgreSQL, Redis, a 32-byte base64 `HF_MCP_DATA_ENCRYPTION_KEY`,
a tenant file (`HF_MCP_TENANTS_FILE`) and an explicit authentication mode. See
`docs/configuration.md` and `docs/deployment.md` for the complete key list.
