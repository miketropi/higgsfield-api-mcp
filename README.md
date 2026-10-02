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

## Requirements

- Node.js >= 22 (`engines` in [`package.json`](package.json))
- Higgsfield API credentials. The dashboard shows `<id>:<secret>`; the API expects the header
  form `Key <id>:<secret>` and the gateway accepts either.
- Docker is **not** required for local stdio use. PostgreSQL and Redis are only needed for
  remote (HTTP) deployments.

## Install

The npm package is **not published to the registry** — install it from this repository
(`https://github.com/miketropi/higgsfield-api-mcp`). The layout below puts the installed
package at `~/.local/share/higgsfield-mcp/node_modules/higgsfield-mcp`, which is what the
host configuration further down points at.

```bash
# 1. source
git clone https://github.com/miketropi/higgsfield-api-mcp ~/.local/share/higgsfield-mcp-src
cd ~/.local/share/higgsfield-mcp-src

# 2. build the packages and the CLI, then pack the npm tarball
corepack enable
pnpm install --frozen-lockfile
pnpm -r run build
pnpm --filter higgsfield-mcp pack --pack-destination "$PWD/artifacts"

# 3. install into the prefix your host will launch, and create the local input root
mkdir -p ~/.local/share/higgsfield-mcp/inputs
npm install --prefix ~/.local/share/higgsfield-mcp "$PWD/artifacts/higgsfield-mcp-0.1.0.tgz"
```

That produces the binary at
`~/.local/share/higgsfield-mcp/node_modules/.bin/higgsfield-mcp` (a shim for
`node_modules/higgsfield-mcp/dist/cli.js`).

Alternatives:

- **Release tarball**, once a tagged release exists:
  `npm install --prefix ~/.local/share/higgsfield-mcp https://github.com/miketropi/higgsfield-api-mcp/releases/download/v0.1.0/higgsfield-mcp-0.1.0.tgz`
- **Container**: `docker build -t higgsfield-mcp:verify .` (non-root, read-only root, SIGTERM).
- **No install at all**, from a working checkout: point the host at
  `node <checkout>/apps/server/dist/cli.js serve --transport stdio`.

## Quick start

The sequence below reaches a first successful generation in about five minutes.

### 1. Store the credential outside the repository

```bash
umask 077
mkdir -p ~/.omp
printf 'Key <id>:<secret>\n' > ~/.omp/higgsfield.credentials
chmod 600 ~/.omp/higgsfield.credentials
```

File mode `0600`, outside any repository. Every deployment path in this project reads the
credential from the environment or from a file like this; no image, tarball, or committed
config carries it.

### 2. Confirm the install before wiring it into a host

```bash
export HF_API_CREDENTIALS="$(cat ~/.omp/higgsfield.credentials)"
~/.local/share/higgsfield-mcp/node_modules/.bin/higgsfield-mcp doctor
```

`doctor` prints one `ok`/`FAIL` line per check (Node version, transport, auth, readiness
checks, allowed paths, asset mode, database, Redis, skills tree) and exits non-zero when a
check fails. It never performs paid generation. `higgsfield-mcp version` prints the gateway
version, the MCP protocol revision, and the Node version.

### 3. Add it to your MCP host

This is the configuration used for OMP / Pi (`~/.omp/agent/mcp.json`), with the install
prefix from the previous section. `!cat` is the host's command indirection: the credential
is read at launch, so no key material sits in the config file.

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "higgsfield": {
      "type": "stdio",
      "command": "/Users/mike/.nvm/versions/node/v24.16.0/bin/node",
      "args": [
        "/Users/mike/.local/share/higgsfield-mcp/node_modules/higgsfield-mcp/dist/cli.js",
        "serve",
        "--transport",
        "stdio"
      ],
      "env": {
        "HF_API_CREDENTIALS": "!cat /Users/mike/.omp/higgsfield.credentials",
        "HF_MCP_LOG_LEVEL": "info",
        "HF_MCP_ALLOWED_PATHS": "/Users/mike/.local/share/higgsfield-mcp/inputs"
      },
      "timeout": 120000
    }
  }
}
```

Adjust the three absolute paths for your machine (`command` = your `node` binary, `args[0]`
= the installed `dist/cli.js`, `HF_MCP_ALLOWED_PATHS` = the directory local uploads may come
from). Paths must be absolute. `timeout` is generous because a cold start loads a bundled
runtime; `jobs.wait` itself is capped server-side at 25 s.

Hosts that expand environment variables instead of running commands can use the generic
pattern (SPEC §72), with the credential passed through the environment:

```json
{
  "mcpServers": {
    "higgsfield": {
      "command": "higgsfield-mcp",
      "env": { "HF_API_CREDENTIALS": "${HF_API_CREDENTIALS}" }
    }
  }
}
```

Reload the host afterwards (`/mcp reload` in OMP, then `/mcp list` and
`/mcp test higgsfield`). The server exposes 14 tools as `mcp__higgsfield__*`, plus five
resources (`higgsfield://models`, `…/models/{id}`, `…/jobs/{id}`, `…/assets/{id}`,
`…/capabilities`). The default command is `serve --transport stdio`; no arguments are
required.

### 4. Generate

Ask the agent for an image, which resolves to a `higgsfield.generate_image` call, or drive
the tools directly:

```jsonc
// higgsfield.models.list  -> {"models": [...]}
// higgsfield.generate_image
{
  "prompt": "a red ceramic cup on a marble counter, soft daylight",
  "wait": true
}
```

A generation is billable. The response is a job object (`input_summary` is a public-safe
summary: string fields become their length, arrays their item count, URL fields are
stripped of their query string):

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
`higgsfield.jobs.get` / `higgsfield.jobs.wait`. Jobs survive a gateway restart when
PostgreSQL is configured.

### 5. Generate from your own files (optional)

Local file inputs are stdio-only and must sit under an allowed path — the
`HF_MCP_ALLOWED_PATHS` directory from the host config above:

```bash
mkdir -p ~/.local/share/higgsfield-mcp/inputs
cp ~/Pictures/reference.png ~/.local/share/higgsfield-mcp/inputs/
```

Then `higgsfield.media.upload` accepts
`{"source": {"path": "/Users/mike/.local/share/higgsfield-mcp/inputs/reference.png"}}` and
returns an `asset_id` usable as `{"type": "asset", "asset_id": "..."}`. With no
`HF_MCP_ALLOWED_PATHS`, local file inputs are denied; use a public HTTPS URL instead.

## CLI

The installed shim is `~/.local/share/higgsfield-mcp/node_modules/.bin/higgsfield-mcp`
(shown below as `higgsfield-mcp`).

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

## Remote deployment

HTTP mode requires authentication (`HF_MCP_AUTH_MODE`), and production deployments add
PostgreSQL, Redis, and object storage. See [`docs/deployment.md`](docs/deployment.md) for the
container contract (non-root, read-only root, SIGTERM) and the environment it needs, and
[`docs/security.md`](docs/security.md) for the auth, scope, rate-limit and webhook model.

## Documentation

| Document | Contents |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Packages, contracts, request path, transports, persistence. |
| [`docs/installation.md`](docs/installation.md) | Install, build, pack, verify. |
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
