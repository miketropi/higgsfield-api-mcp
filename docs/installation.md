# Installation and setup

Complete setup path for the Higgsfield API MCP Gateway: install, credential handling, host
configuration, verification, guardrails, upgrades and troubleshooting. For the short version
see the [README](../README.md#setup).

The npm package is **not published to the registry**. It is installed from
<https://github.com/miketropi/higgsfield-api-mcp>.

## What you need

| Requirement | Check | Notes |
|---|---|---|
| Node.js 22 or newer | `node --version` | `engines` in `package.json` and `apps/server/package.json`. The gateway uses the global `fetch`, `AbortSignal.timeout`, and `Promise.withResolvers`. |
| pnpm | `pnpm --version` | Only for building from source. `corepack enable` provisions the version pinned in the root `packageManager` field. |
| git | `git --version` | To clone. Not needed for the tarball or container routes. |
| A Higgsfield API credential | — | From your Higgsfield account's API keys page. The dashboard shows `<id>:<secret>`; the HTTP API expects `Key <id>:<secret>`. The gateway accepts either. |
| An MCP host | — | OMP/Pi, Claude Code/Desktop, Cursor, Windsurf, VS Code, Codex, or any stdio MCP client. |
| Docker | `docker --version` | Optional — only the container route. PostgreSQL and Redis are only needed in remote (HTTP) mode. |

## Where things live

Pick these once; every command below uses the same three variables. They are ordinary
`$HOME`-relative paths, so they work on macOS, Linux and WSL without editing.

```bash
HF_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/higgsfield-mcp"   # install prefix + local input root
HF_SRC="${XDG_CACHE_HOME:-$HOME/.cache}/higgsfield-mcp-src"     # build checkout (disposable after install)
HF_CREDS="${XDG_CONFIG_HOME:-$HOME/.config}/higgsfield-mcp/credentials"
```

| Path | Holds |
|---|---|
| `$HF_HOME/node_modules/higgsfield-mcp/` | The installed package: `dist/cli.js`, bundled migrations, `README.md`. |
| `$HF_HOME/node_modules/.bin/higgsfield-mcp` | The bin shim (a symlink to `dist/cli.js`); this is what the host can also launch directly. |
| `$HF_HOME/inputs/` | Default root for `higgsfield.media.upload` local file inputs — the value you give `HF_MCP_ALLOWED_PATHS`. |
| `$HF_CREDS` | `Key <id>:<secret>`, mode `600`, outside any repository. |
| `$HF_SRC` | Clone used for the build; can be deleted after installing. |

Two constraints worth knowing before you choose paths:

- **Keep them off cloud-synced folders** (iCloud Drive, Dropbox, OneDrive). On macOS,
  `~/Desktop` and `~/Documents` are often iCloud-backed; a cold start that has to fetch
  files can exceed the host's startup timeout.
- **Host configs do not expand `~` or shell variables.** Whatever ends up in the host's JSON
  must be an absolute path.

## Install routes

| Route | Use when | What you get |
|---|---|---|
| **A. From a clone** (below) | Default. Any machine with Node + pnpm. | Full install with the CLI, migrations and skills tree. |
| **B. Release tarball** | A version was released and you do not want a toolchain. | Same install, no build step. |
| **C. Container** | Remote HTTP deployment, or you want an isolated runtime. | Image with the CLI served over HTTP. |
| **D. No install** | You are developing the gateway itself. | Host launches `node <checkout>/apps/server/dist/cli.js`. |

### A. From a clone (default)

```bash
HF_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/higgsfield-mcp"
HF_SRC="${XDG_CACHE_HOME:-$HOME/.cache}/higgsfield-mcp-src"

git clone https://github.com/miketropi/higgsfield-api-mcp "$HF_SRC"
cd "$HF_SRC"
corepack enable
pnpm install --frozen-lockfile
pnpm -r run build
pnpm --filter higgsfield-mcp pack --pack-destination "$HF_SRC/artifacts"

mkdir -p "$HF_HOME/inputs"
npm install --prefix "$HF_HOME" "$HF_SRC/artifacts/higgsfield-mcp-0.1.0.tgz"
```

`pnpm pack` runs the package's own `build` script and rewrites `workspace:*` dependency
specifiers, so the tarball installs standalone into any prefix — the `@higgsfield-mcp/*`
workspace packages are bundled into `dist`, and only public npm dependencies are fetched.
The installed package exposes `bin.higgsfield-mcp -> ./dist/cli.js` and ships `dist` plus its
`README.md`.

Confirm the result before configuring anything:

```bash
"$HF_HOME/node_modules/.bin/higgsfield-mcp" version
```

### B. Release tarball

Tagged releases attach the npm tarball, an image tar, and an SPDX SBOM. Once a release
exists for the version you want:

```bash
HF_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/higgsfield-mcp"
mkdir -p "$HF_HOME/inputs"
npm install --prefix "$HF_HOME" \
  https://github.com/miketropi/higgsfield-api-mcp/releases/download/v0.1.0/higgsfield-mcp-0.1.0.tgz
```

### C. Container

```bash
docker build -t higgsfield-mcp:local .
docker run --rm -e HF_API_CREDENTIALS="Key <id>:<secret>" higgsfield-mcp:local doctor
```

The image runs as a non-root user with a read-only root filesystem and stops on SIGTERM.
Remote serving, compose, migrations and secret wiring are covered in
[deployment.md](deployment.md) and [security.md](security.md).

### D. No install (development checkout)

```bash
node "$HF_SRC/apps/server/dist/cli.js" doctor
# host: command=node, args=[<checkout>/apps/server/dist/cli.js, serve, --transport stdio]
```

Verified by `pnpm test:e2e -- --profile distribution`, which packs the tarball, installs it
into a disposable directory, and drives it over stdio with a real MCP client.

## Configure your MCP host

Every client needs the same four things: a program to run, its arguments, environment
variables, and a timeout. The entry object below is the portable shape; only the surrounding
file and its top-level key differ between clients.

```json
{
  "higgsfield": {
    "type": "stdio",
    "command": "<NODE>",
    "args": ["<CLI>", "serve", "--transport", "stdio"],
    "env": {
      "HF_API_CREDENTIALS": "<CREDENTIALS>",
      "HF_MCP_LOG_LEVEL": "info",
      "HF_MCP_ALLOWED_PATHS": "<INPUTS>"
    },
    "timeout": 120000
  }
}
```

| Field | Value | Why |
|---|---|---|
| `command` | Absolute path to `node` (`command -v node`) | Hosts often launch without your shell `PATH`, so `node` may not resolve. An absolute path always works. |
| `args[0]` | Absolute path to `dist/cli.js` | `$HF_HOME/node_modules/higgsfield-mcp/dist/cli.js`. |
| `args[1..]` | `serve --transport stdio` | The default, stated explicitly. stdio is the transport for a locally spawned server: MCP messages on stdout, logs on stderr. |
| `HF_API_CREDENTIALS` | `Key <id>:<secret>` or `<id>:<secret>` | Provider credential. Never commit it — see the routes below. |
| `HF_MCP_LOG_LEVEL` | `info` (or `debug`, `error`) | `debug` while diagnosing. Logs never go to stdout, so they cannot corrupt the protocol stream. |
| `HF_MCP_ALLOWED_PATHS` | Absolute directory, or comma-separated list | Roots that `higgsfield.media.upload` may read local files from. Omitted or empty ⇒ local file inputs denied. |
| `timeout` | `120000` ms | Per-request budget. A cold start on a slow filesystem can take seconds; `jobs.wait` is capped server-side at 25 s regardless, so a large value never means a hung 2-minute call. |

### Host matrix

| Client | Configuration file | Shape |
|---|---|---|
| **OMP / Pi** | `~/.omp/agent/mcp.json` | `mcpServers` object; supports `!cat <file>` and `!<command>` indirection in `env` values, plus `"$schema"`. |
| **Claude Code / Desktop** | `.mcp.json` (project) or `~/.claude.json` (user) | `mcpServers` object; expands `${VAR}` in the entry. `claude mcp add-json higgsfield '<entry>'` writes it for you. |
| **Cursor** | `~/.cursor/mcp.json` | `mcpServers` object with the same entry. |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` object with the same entry. |
| **VS Code** | `.vscode/mcp.json` | Same entry object under that client's own top-level key — check its documentation for the key name. |
| **Codex** | `~/.codex/config.toml` | TOML `[mcp_servers.higgsfield]` table; the same values as keys. |
| **Remote/Hosted** | — | `"type": "http"`, `"url": "https://<host>/mcp"`, `"headers": {"Authorization": "Bearer <token>"}`. HTTP mode requires `HF_MCP_AUTH_MODE` on the server. |

### Credential handling

Four options, safest first:

1. **Command indirection** (OMP/Pi) — the host runs the command at launch and uses the
   trimmed stdout:

   ```json
   { "env": { "HF_API_CREDENTIALS": "!cat <ABS_PATH_TO_CREDS>" } }
   ```

   The wildcard form `!<command>` invokes an executable by path. Use an absolute path; `~`
   is not expanded.
2. **Environment passthrough** — export `HF_API_CREDENTIALS` in the shell that launches the
   host and either omit the `env` entry (most hosts inherit the environment) or use the
   host's variable-name indirection: a bare `"HF_API_CREDENTIALS"` value (OMP/Pi) copies it
   from the environment.
3. **Template expansion** — `"HF_API_CREDENTIALS": "${HF_API_CREDENTIALS}"` where the client
   expands `${VAR}` (Claude Code does; verify per client).
4. **Inline the value** — works everywhere, but the credential then sits in a config file in
   plain text. If you must, keep that file mode `600` and out of version control.

Store the file itself with `600`, written outside any repository:

```bash
mkdir -p "$(dirname "$HF_CREDS")"
umask 077
printf 'Key <id>:<secret>\n' > "$HF_CREDS"
chmod 600 "$HF_CREDS"
```

The gateway never logs, returns, or persists the credential, and it accepts both credential
forms — the `Key …` prefix is added automatically when the value is a bare `<id>:<secret>`.

### Reload the host

OMP/Pi: `/mcp reload`, then `/mcp list` and `/mcp test higgsfield`. Claude Code:
`claude mcp list` should show `✔ Connected`; `/mcp` inside a session shows the same. Cursor
and Windsurf reload their MCP config when the settings file is saved. In all cases, a
successful connection means the tool list appears — 14 tools, exposed as
`mcp__higgsfield__*` in OMP/Pi — plus five resources (`higgsfield://models`,
`higgsfield://models/{+id}`, `higgsfield://jobs/{id}`, `higgsfield://assets/{id}`,
`higgsfield://capabilities`).

## Verify the install

```bash
higgsfield-mcp version
```

prints the gateway version, the MCP protocol revision (`2026-07-28`), and the Node version.

```bash
higgsfield-mcp doctor
```

prints one `ok`/`FAIL` line per check and exits non-zero when any check fails. The checks, in
the order they are printed (`runDoctor` in `apps/server/src/cli.ts`):

| Check | Meaning |
|---|---|
| `node` | Node major version is at least 22. |
| `transport` | The resolved transport and its `host:port`. |
| `auth` | The auth mode, or stdio (which is implicitly the local tenant). |
| readiness checks | `repository`, `rate_limiter`, `object_storage` (only when a bucket is configured), `provider_catalog`, `provider_credentials` — each is a real call, not a configuration echo. |
| `allowed_paths` | The configured local media roots, or `empty (local file inputs denied)`. |
| `allowed_path:<path>` | Each root exists and is a directory. |
| `asset_mode` | `passthrough` or `managed`. |
| `database` | Whether a PostgreSQL URL is configured. |
| `redis` | Whether a Redis URL is configured. |
| `skills` | The generated skills tree, summarised from the manifest; reports `no generated skills tree found` when absent. |

`doctor` never performs a generation and never spends money.

Then verify through the host: an empty tool list means the host could not start the process —
re-check `command`, `args[0]`, and that the prefix actually exists. A first call to
`higgsfield.models.list` is free and proves the round trip; `higgsfield.generate_image` is
billable. `models.list` is the only surface that needs outbound access to
`https://docs.higgsfield.ai`; generation, job handling and `tools/list` work without it, and a
discovery outage surfaces as `PROVIDER_ERROR` with `details.reason: catalog_unavailable`.

## Local file inputs

`higgsfield.media.upload` accepts `{"source": {"path": "..."}}` for files under the
configured roots:

```bash
mkdir -p "$HF_HOME/inputs"
cp ~/Pictures/reference.png "$HF_HOME/inputs/"
export HF_MCP_ALLOWED_PATHS="$HF_HOME/inputs"
```

The returned `asset_id` can be used as `{"type": "asset", "asset_id": "..."}` in any
generation call. Rules that matter:

- **Empty or unset `HF_MCP_ALLOWED_PATHS` denies local file inputs** — the safe default. Use
  a public HTTPS URL instead.
- Multiple roots: comma-separated, each absolute.
- Paths are resolved before the check, so a symlink or `..` that escapes a root is refused
  (`INVALID_INPUT`), as is any path outside the roots.
- Local file inputs are stdio-only. Remote HTTP callers use `higgsfield://assets/{id}` or
  public URLs, because the server cannot read their filesystem.
- Only `higgsfield.media.upload` takes a local `path`; `higgsfield.media.get` works from an `asset_id` alone.

## Cost guardrails

No spending cap is active unless you configure one. These are opt-in, per-server, and can be
combined ([configuration.md](configuration.md) has the full list):

| Variable | Effect |
|---|---|
| `HF_MCP_MAX_JOB_COST_USD` | Reject a single job whose estimate exceeds this. |
| `HF_MCP_DAILY_COST_LIMIT_USD` | Per-tenant ceiling on committed spend per UTC day. |
| `HF_MCP_REQUIRE_CONFIRM_ABOVE_USD` | Above this estimate the call returns `{"status": "confirmation_required", "estimated_cost_usd": …, "confirmation_token": …, "expires_at": …}` instead of submitting. Resubmit the identical call with `confirmation_token`. |
| `HF_MCP_RATE_LIMITS_FILE` | JSON file with per-tenant, per-token, per-tool and per-provider admission limits. |
| `HF_MCP_MODEL_ALIASES_FILE` | Operator aliases (`image.default` → a model id) and price overrides. |
| `HF_MCP_ASSET_MODE=managed` | Copy results into S3-compatible storage and hand out short-lived signed URLs instead of provider URLs. Requires an S3 bucket, credentials, and `HF_MCP_DATA_ENCRYPTION_KEY` (32 base64 bytes). |

With any cost control active, an endpoint whose price the provider does not publish is
refused (`POLICY_REJECTED`) rather than guessed at — the gateway never invents a price.

## Persistence setup

Remote (HTTP) deployments need the schema to exist before the gateway serves:

```bash
export HF_MCP_DATABASE_URL="postgres://user:password@host:5432/higgsfield_mcp"
higgsfield-mcp migrate
```

`migrate` is the only supported way to create schema — the repository never runs DDL at
startup. It takes a PostgreSQL advisory lock for the whole run, applies each file in its own
transaction, and is a no-op when re-run. It fails fast when `HF_MCP_DATABASE_URL` is unset.

When running from a container image, the migrations are staged at
`apps/server/dist/migrations`; a plain workspace build does not copy them into `dist`, so run
`migrate` from the image (or from the source tree via `pnpm migrate`).

stdio deployments do not need PostgreSQL: jobs live in memory for the process lifetime, so a
restart drops the history. Configure `HF_MCP_DATABASE_URL` when job durability matters.

## Skills tree

The gateway resolves the generated skills tree in this order
(`apps/server/src/skills-dir.ts`):

1. `HF_MCP_SKILLS_DIR`, resolved against the working directory;
2. `<directory of the built CLI>/skills` (this is where the container image places it);
3. `<directory of the built CLI>/../skills`;
4. `<working directory>/skills`.

The first candidate that contains a `manifest.json` wins. Without one, `doctor` reports
`no generated skills tree found`, `higgsfield-mcp skills list` prints
`skills: no generated skills tree found (set HF_MCP_SKILLS_DIR or run pnpm skills:sync)`, and
`higgsfield://capabilities` reports `skills_version: "unavailable"`. Generation is unaffected.

For a source checkout, point at the checked-in tree:

```bash
export HF_MCP_SKILLS_DIR="$HF_SRC/skills"
```

See [skills.md](skills.md).

## Upgrading

```bash
cd "$HF_SRC"
git fetch --tags && git checkout <new-tag-or-commit>
corepack enable
pnpm install --frozen-lockfile
pnpm -r run build
pnpm --filter higgsfield-mcp pack --pack-destination "$HF_SRC/artifacts"
npm install --prefix "$HF_HOME" "$HF_SRC/artifacts/higgsfield-mcp-<new-version>.tgz"
"$HF_HOME/node_modules/.bin/higgsfield-mcp" version
```

Then restart the host (OMP/Pi: `/mcp reload`) so the new process is spawned. An `npm install`
into the same prefix replaces the package in place; the prefix is self-contained, so removing
it is a complete uninstall of the binary. Run `higgsfield-mcp migrate` after upgrading when
PostgreSQL is configured. Persisted jobs survive the upgrade.

## Uninstall

```bash
# 1. remove the host entry for "higgsfield" from its MCP config file
# 2. remove the install, the build checkout and the credential
rm -rf "$HF_HOME" "$HF_SRC" "$HF_CREDS"
# 3. optional: drop the database schema / volume
#    dropdb higgsfield_mcp
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Host lists no tools, or reports the server failed to start | `command` or `args[0]` is wrong, `node` is not on the host's `PATH`, or the prefix was never installed | Run the CLI by hand: `"$HF_HOME/node_modules/.bin/higgsfield-mcp" version`. Then paste the printed absolute paths into the config; do not use `~`. |
| `doctor` FAIL `node` | Node older than 22 | Install Node 22+ and point `command` at that binary. |
| `doctor` FAIL `provider_credentials` | The host process cannot see the credential | Use `!cat` with an absolute path, or an env-var name the host resolves. Check the file exists, is readable, and is `600`. |
| Provider returns 401 / `AUTHENTICATION_FAILED` | Wrong, revoked, or truncated key (a trailing newline is a classic) | Re-copy the key; both `<id>:<secret>` and `Key <id>:<secret>` are accepted, and surrounding whitespace is trimmed. |
| Calls time out on first use, then work | Cold start on a slow or network-synced filesystem | Raise `timeout` to `120000`; move `$HF_HOME` off cloud-synced folders. |
| `INVALID_INPUT` when uploading a local file | File outside `HF_MCP_ALLOWED_PATHS`, escaping root via symlink, or the root does not exist | Move the file under the root and create the root directory first, or pass a public HTTPS URL. |
| Local file input refused with no path detail | No allowed paths configured (the default) | Set `HF_MCP_ALLOWED_PATHS` and restart the host. |
| `RATE_LIMITED` | Admission limits from `HF_MCP_RATE_LIMITS_FILE` | Read `details.limited_by` and `retry_after_ms` in the error envelope; raise the limit or wait. |
| A result with `status: "confirmation_required"` instead of a job | `HF_MCP_REQUIRE_CONFIRM_ABOVE_USD` is set and the estimate exceeds it | Resubmit the identical call with `confirmation_token`. The token is single use, expires after ~10 minutes (default), and is bound to the tool, tenant and exact request payload — a changed payload fails with `POLICY_REJECTED` (`reason: request_changed`) |
| `POLICY_REJECTED` | A cost control is active and the provider publishes no price, or a webhook URL is not gateway-owned | Disable the cost control, or use a gateway-owned webhook URL. |
| `UPSTREAM_UNAVAILABLE` / `PROVIDER_ERROR` | Higgsfield API outage or a rejected request | Check `details` for the provider response; a retryable error carries a `retryable` flag. |
| Jobs disappeared after restart | stdio without PostgreSQL keeps jobs in memory | Configure `HF_MCP_DATABASE_URL` and run `migrate`. |
| Host shows tools but every call fails with a transport error | Something wrote to stdout | The gateway logs only to stderr; check for a wrapper command in `command`/`args` that echoes output. |

## See also

- [configuration.md](configuration.md) — every environment variable, defaults, config file, tenants.
- [deployment.md](deployment.md) — container, compose, migrations, secrets.
- [security.md](security.md) — auth modes, scopes, SSRF and path protections, webhooks.
- [tools.md](tools.md) — tool schemas, resources, error envelope.
- [compatibility.md](compatibility.md) — what is verified against the live provider, and what is not.
