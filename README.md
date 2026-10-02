# Higgsfield API MCP Gateway

![Higgsfield API MCP Gateway](docs/thumbnail.jpg)

An MCP server that gives MCP-compatible agents the Higgsfield generative media API: image
generation and editing, video generation and animation, media upload, a model catalog, and
job inspection — over stdio or Streamable HTTP, with structured errors, cost controls,
rate limiting, and production persistence.

The gateway does not replace the creative workflow. Skills and agents decide what to make;
the gateway handles models, media, jobs, provider execution, security and observability.

- Specification: [`SPEC.md`](SPEC.md)
- 14 tools, 5 resources: [`docs/tools.md`](docs/tools.md)
- Every environment variable: [`docs/configuration.md`](docs/configuration.md)
- Full setup guide, host matrix and troubleshooting: [`docs/installation.md`](docs/installation.md)

## What you need

| Requirement | Notes |
|---|---|
| **Node.js 22+** | `node --version`. The gateway uses global `fetch`, `AbortSignal.timeout` and `Promise.withResolvers`. |
| **pnpm** | Only to build from source. `corepack enable` provisions the pinned `packageManager` version. |
| **A Higgsfield API key** | From your Higgsfield account's API keys page. The dashboard shows `<id>:<secret>`; the HTTP API wants `Key <id>:<secret>`. This gateway accepts **either** form. |
| **An MCP host** | OMP/Pi, Claude Code, Cursor, Windsurf, Codex, or any client that speaks stdio MCP. |

Docker is optional (container path). PostgreSQL, Redis and object storage are only needed for
remote HTTP deployments — local stdio use needs neither.

## Setup

Every step is copy-paste. It uses `$HOME`-relative locations so it works on any machine; run
`echo` at the end to get the four absolute paths your host configuration needs.

### Step 1 — Choose your locations and build the package

The npm package is **not published to the registry**, so it is installed from this
repository (`https://github.com/miketropi/higgsfield-api-mcp`). The script below clones,
builds, packs and installs into a per-user prefix, then prints the paths.

```bash
# Install prefix (the host launches the CLI from here), build checkout, credential file.
HF_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/higgsfield-mcp"
HF_SRC="${XDG_CACHE_HOME:-$HOME/.cache}/higgsfield-mcp-src"
HF_CREDS="${XDG_CONFIG_HOME:-$HOME/.config}/higgsfield-mcp/credentials"

git clone https://github.com/miketropi/higgsfield-api-mcp "$HF_SRC"
cd "$HF_SRC"
corepack enable
pnpm install --frozen-lockfile
pnpm -r run build
pnpm --filter higgsfield-mcp pack --pack-destination "$HF_SRC/artifacts"

mkdir -p "$HF_HOME/inputs"
npm install --prefix "$HF_HOME" "$HF_SRC/artifacts/higgsfield-mcp-0.1.0.tgz"
```

Result: `$HF_HOME/node_modules/higgsfield-mcp/dist/cli.js` and the `higgsfield-mcp` shim at
`$HF_HOME/node_modules/.bin/higgsfield-mcp`. Other install routes (container, release
tarball, no-install checkout) are listed in
[`docs/installation.md`](docs/installation.md#install-routes).

### Step 2 — Store the credential outside any repository

The host configuration below reads the credential from a file at launch instead of embedding
it, so no key material ever lands in a config file or a commit.

```bash
mkdir -p "$(dirname "$HF_CREDS")"
umask 077
printf 'Key <id>:<secret>\n' > "$HF_CREDS"     # paste your id and secret here
chmod 600 "$HF_CREDS"
```

`Key ` is optional here — a bare `<id>:<secret>` pasted from the dashboard works too. Keep
the file readable only by you (`600`); the gateway never logs or returns it.

### Step 3 — Print the four absolute paths for your host config

Host configurations do not expand `~` or shell variables, so paste real absolute paths.

```bash
echo "command            : $(command -v node)"
echo "args[0]            : $HF_HOME/node_modules/higgsfield-mcp/dist/cli.js"
echo "credentials file   : $HF_CREDS"
echo "allowed inputs dir : $HF_HOME/inputs"
```

### Step 4 — Add the server to your MCP host

The portable shape — accepted by OMP/Pi, Claude Code/Desktop, Cursor, Windsurf, VS Code,
Gemini CLI and most other clients, under the key `mcpServers`:

```json
{
  "mcpServers": {
    "higgsfield": {
      "type": "stdio",
      "command": "<NODE>",
      "args": ["<CLI>", "serve", "--transport", "stdio"],
      "env": {
        "HF_API_CREDENTIALS": "<CREDENTIALS_STRING>",
        "HF_MCP_LOG_LEVEL": "info",
        "HF_MCP_ALLOWED_PATHS": "<INPUTS>"
      },
      "timeout": 120000
    }
  }
}
```

| Field | What to put there |
|---|---|
| `command` | The absolute path to `node` (from step 3). Some hosts accept `"node"` if it is on their `PATH`; an absolute path always works. |
| `args[0]` | The absolute path to the installed `dist/cli.js` (from step 3). |
| `args[1..]` | `serve --transport stdio`. With no arguments the CLI does the same, but being explicit avoids surprises. |
| `HF_API_CREDENTIALS` | `Key <id>:<secret>` or `<id>:<secret>`. Either inline it, or use your host's secret indirection — see below. |
| `HF_MCP_LOG_LEVEL` | `info` is a good default; use `debug` while diagnosing, `error` for quiet operation. Logs always go to stderr, never stdout. |
| `HF_MCP_ALLOWED_PATHS` | Absolute directory (or comma-separated list) that `higgsfield.media.upload` may read local files from. Empty or omitted means local file uploads are denied and callers must pass public HTTPS URLs. |
| `timeout` | Per-request budget in ms. `120000` tolerates a cold start; `jobs.wait` is capped server-side at 25 s regardless. |

**Never paste a real credential into a file you commit.** Prefer your host's indirection:

- **OMP / Pi** (`~/.omp/agent/mcp.json`) — native config file, with command indirection so
  the secret is read at launch:

  ```json
  {
    "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
    "mcpServers": {
      "higgsfield": {
        "type": "stdio",
        "command": "<NODE>",
        "args": ["<CLI>", "serve", "--transport", "stdio"],
        "env": {
          "HF_API_CREDENTIALS": "!cat <CREDS>",
          "HF_MCP_LOG_LEVEL": "info",
          "HF_MCP_ALLOWED_PATHS": "<INPUTS>"
        },
        "timeout": 120000
      }
    }
  }
  ```
  `<CREDS>` must be an absolute path (no `~`). `!cat …` means "run this at launch and use its
  trimmed stdout". A value that names an environment variable (`"HF_API_CREDENTIALS"`) copies
  it from the environment instead.
- **Hosts that expand `${VAR}`** — keep `HF_API_CREDENTIALS` in the environment the host is
  launched from and write `"HF_API_CREDENTIALS": "${HF_API_CREDENTIALS}"`.
- **Other hosts** — the same `mcpServers` object goes in that host's MCP file (Claude:
  `.mcp.json`; Cursor: `~/.cursor/mcp.json`; Windsurf: `~/.codeium/windsurf/mcp_config.json`;
  VS Code: `.vscode/mcp.json` under `mcp.servers`; Codex: `~/.codex/config.toml` under
  `[mcp_servers.higgsfield]`). Field names follow the client's own documentation.

### Step 5 — Verify before spending anything

```bash
"$HF_HOME/node_modules/.bin/higgsfield-mcp" doctor
```

`doctor` prints one `ok`/`FAIL` line per check — Node version, transport, auth mode,
repository/rate-limiter/provider readiness, allowed paths, asset mode, database, Redis, and
the skills tree — and exits non-zero if anything fails. It never performs paid generation.

Then reload the host and confirm the server is live:

```
/mcp reload          # OMP/Pi; other hosts vary
/mcp list            # the server should be listed
/mcp test higgsfield # connects and lists tools
```

The server exposes 14 tools (named `mcp__higgsfield__*` in OMP/Pi) and five resources:
`higgsfield://models`, `higgsfield://models/{id}`, `higgsfield://jobs/{id}`,
`higgsfield://assets/{id}`, `higgsfield://capabilities`.

### Step 6 — First generation

Ask the agent for an image, or drive the tools directly. Start with a read-only call, which
costs nothing:

```jsonc
// higgsfield.models.list -> {"models": [{"id": "xai/grok-imagine-image-2.0", ...}]}
```

Then generate. **This is billable** — the estimate below is what the provider returns for a
2k Grok image:

```jsonc
// higgsfield.generate_image
{ "prompt": "a red ceramic cup on a marble counter, soft daylight", "wait": true }
```

The response is a job object. `input_summary` is a deliberately public-safe summary: string
fields become their length, arrays their item count, and URL fields are stripped of their
query string.

```jsonc
{
  "job_id": "job_9f1c...",
  "status": "completed",
  "provider": "higgsfield",
  "capability": "image_generation",
  "model": "xai/grok-imagine-image-2.0",
  "endpoint": "xai/grok-imagine-image-2.0",
  "created_at": "2026-10-02T00:00:00.000Z",
  "updated_at": "2026-10-02T00:00:12.000Z",
  "input_summary": { "prompt": { "length": 46 }, "quality": "medium" },
  "assets": [
    {
      "asset_id": "asset_3b7a...",
      "url": "https://...",
      "media_type": "image",
      "mime_type": "image/png",
      "created_at": "2026-10-02T00:00:12.000Z"
    }
  ],
  "cost": { "currency": "USD", "estimated_cost_usd": 0.094, "source": "estimate_api" }
}
```

Long jobs do not need one long MCP request: submit with `"wait": false`, then poll with
`higgsfield.jobs.get` or `higgsfield.jobs.wait`. Jobs survive a gateway restart when
PostgreSQL is configured.

### Step 7 — Generate from your own files (optional)

Local file inputs are stdio-only and must live under `HF_MCP_ALLOWED_PATHS`:

```bash
cp ~/Pictures/reference.png "$HF_HOME/inputs/"
```

Then `higgsfield.media.upload` accepts
`{"source": {"path": "<INPUTS>/reference.png"}}` and returns an `asset_id` usable as
`{"type": "asset", "asset_id": "..."}` in any generation call. With no allowed paths
configured, local file inputs are refused (`INVALID_INPUT`) — pass a public HTTPS URL
instead.

## Guardrails you can switch on

Nothing is capped by default. Add these to the `env` block (all are optional, all are
opt-in) when an agent will call tools unattended — see
[`docs/configuration.md`](docs/configuration.md):

| Variable | Effect |
|---|---|
| `HF_MCP_MAX_JOB_COST_USD` | Reject a job whose estimate exceeds this. |
| `HF_MCP_DAILY_COST_LIMIT_USD` | Per-tenant ceiling on committed spend per UTC day. |
| `HF_MCP_REQUIRE_CONFIRM_ABOVE_USD` | Above this estimate the call returns `{"status": "confirmation_required", "estimated_cost_usd": …, "confirmation_token": …, "expires_at": …}` instead of submitting. Resubmit the identical call with `confirmation_token` to proceed. |
| `HF_MCP_RATE_LIMITS_FILE` | JSON file with per-tenant/token/tool/provider admission limits. |
| `HF_MCP_MODEL_ALIASES_FILE` | Operator aliases (`image.default` → a model id) and price overrides. |
| `HF_MCP_ASSET_MODE=managed` | Copy results into S3-compatible storage and expose short-lived signed URLs. Requires `HF_MCP_S3_BUCKET`, `HF_MCP_S3_ACCESS_KEY_ID`, `HF_MCP_S3_SECRET_ACCESS_KEY` and `HF_MCP_DATA_ENCRYPTION_KEY`. |

With any cost control active, an endpoint whose price the provider does not publish is
refused (`POLICY_REJECTED`) rather than guessed at.

## When something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| The host lists no tools, or "server failed to start" | `args[0]` or `command` is wrong; the prefix was never installed | Re-run step 3, then run the CLI directly: `"$HF_HOME/node_modules/.bin/higgsfield-mcp" version` |
| `AUTHENTICATION_FAILED` / 401 from the provider | Wrong or revoked key, or the value was mangled by the host's secret handling | `higgsfield-mcp doctor`; either credential form is accepted |
| `doctor` fails `provider_credentials` | The host process cannot see `HF_API_CREDENTIALS` | Use `!cat <abs path>` or an env-var name, not a relative path, and check the file mode (`600`) |
| Tool calls time out on first use | Cold start on a slow or network-synced filesystem | Raise `timeout` to `120000`; keep the install prefix off cloud-synced folders (e.g. iCloud Desktop/Documents) |
| `INVALID_INPUT` for a local file | The file is outside `HF_MCP_ALLOWED_PATHS`, or that directory does not exist | Create the directory, move the file inside it, or pass a public HTTPS URL |
| Local file input refused entirely | No allowed paths configured (the default) | Set `HF_MCP_ALLOWED_PATHS` and restart the host |
| `RATE_LIMITED` | Admission limits from `HF_MCP_RATE_LIMITS_FILE` | Inspect `details.limited_by` in the error envelope and the `retry_after_ms` hint |
| A result with `status: "confirmation_required"` instead of a job | `HF_MCP_REQUIRE_CONFIRM_ABOVE_USD` is set and the estimate exceeds it | Resubmit the **identical** call with `"confirmation_token": "<token>"` added. Single use, expires after ~10 minutes; a changed payload or a risen price is rejected (`POLICY_REJECTED`) |

## Remote (HTTP) mode

For multi-agent or hosted use, run `serve --transport http`; it adds `POST /mcp`, `/health`,
`/ready`, `/metrics` and the webhook route, and requires authentication plus PostgreSQL and
Redis. Container, compose and migration details are in
[`docs/deployment.md`](docs/deployment.md); auth modes, scopes, rate limits and the webhook
trust model are in [`docs/security.md`](docs/security.md).

## CLI

The installed shim is `$HF_HOME/node_modules/.bin/higgsfield-mcp` (shown below as
`higgsfield-mcp`).

| Command | Purpose |
|---|---|
| `higgsfield-mcp` | Same as `serve --transport stdio`. |
| `higgsfield-mcp serve --transport stdio` | Serve MCP on stdin/stdout. |
| `higgsfield-mcp serve --transport http --host 0.0.0.0 --port 3000` | Serve Streamable HTTP plus `/health`, `/ready`, `/metrics`, and the webhook route. |
| `higgsfield-mcp serve --config ./gateway.json` | Serve using a JSON config file. |
| `higgsfield-mcp doctor` | Environment and readiness checks; never performs paid generation. |
| `higgsfield-mcp models` | Print the bundled model catalog, one model per line. |
| `higgsfield-mcp skills list` | Print the pinned upstream revision and the per-skill classification. |
| `higgsfield-mcp skills sync [--upstream <url>]` | Re-generate the skills tree from the pinned upstream. |
| `higgsfield-mcp skills check-upstream` | Report upstream drift; non-zero exit when the pin is stale. |
| `higgsfield-mcp skills validate` | Validate the generated skills tree against the bundled model catalog. |
| `higgsfield-mcp version` | Print version, MCP protocol revision, and Node version. |
| `higgsfield-mcp migrate` | Apply PostgreSQL migrations (requires `HF_MCP_DATABASE_URL`). |
| `higgsfield-mcp jobs reconcile <job-id> --provider-job-id <id> --tenant <t>` | Re-attach a persisted job to a provider request after an ambiguous submission. |

Configuration precedence is CLI arguments, then environment, then the `--config` file, then
built-in defaults. Invalid configuration fails fast at startup with an issue list.

## Documentation

| Document | Contents |
|---|---|
| [`docs/installation.md`](docs/installation.md) | Full setup guide: install routes, host matrix, verification, upgrades, troubleshooting. |
| [`docs/architecture.md`](docs/architecture.md) | Packages, contracts, request path, transports, persistence. |
| [`docs/configuration.md`](docs/configuration.md) | Every environment variable, defaults, config file, tenants/rate-limit/alias files. |
| [`docs/tools.md`](docs/tools.md) | All 14 tools, their fields, the resources, the error envelope. |
| [`docs/skills.md`](docs/skills.md) | Skill classification, upstream pinning, sync and validation. |
| [`docs/deployment.md`](docs/deployment.md) | Docker, compose, migrations, secrets. |
| [`docs/security.md`](docs/security.md) | Auth modes, scopes, rate limits, SSRF and path protections, webhook trust model. |
| [`docs/observability.md`](docs/observability.md) | Log events, redaction, metric names, tracing. |
| [`docs/compatibility.md`](docs/compatibility.md) | Model and skill compatibility, with honest per-row status. |
| [`docs/contributing.md`](docs/contributing.md) | Layout, scripts, test levels, the end-to-end harness. |

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test:unit
pnpm test:contract
pnpm test:integration
```

`pnpm test:e2e -- --profile distribution` packs the npm tarball, installs it into a
disposable directory, drives it over stdio with a real MCP client, then builds and runs the
container against the compose dependencies and a local fixture provider. The `live` profile
is the only one that spends money and refuses to run without an explicit budget. See
[`docs/contributing.md`](docs/contributing.md).

## License

MIT (`apps/server/package.json`).
