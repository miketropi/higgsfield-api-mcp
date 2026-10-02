# Installation

## Requirements

- Node.js 22 or newer (`engines` in `package.json` and `apps/server/package.json`). The
  gateway uses the global `fetch`, `AbortSignal.timeout`, and `Promise.withResolvers`.
- Higgsfield API credentials, formatted `Key <id>:<secret>`, supplied through the
  environment as `HF_API_CREDENTIALS`.
- Docker is only needed for the container and compose paths. PostgreSQL and Redis are only
  needed in remote (HTTP) mode.

## Install from this repository

The npm package is **not published to the registry**, so `npx -y higgsfield-mcp` and
`npm install -g higgsfield-mcp` do not work. Install from
`https://github.com/miketropi/higgsfield-api-mcp` instead — the README's
[Install](../README.md#install) section has the copy-paste sequence. In short:

```bash
git clone https://github.com/miketropi/higgsfield-api-mcp ~/.local/share/higgsfield-mcp-src
cd ~/.local/share/higgsfield-mcp-src
corepack enable
pnpm install --frozen-lockfile
pnpm -r run build
pnpm --filter higgsfield-mcp pack --pack-destination "$PWD/artifacts"

mkdir -p ~/.local/share/higgsfield-mcp/inputs
npm install --prefix ~/.local/share/higgsfield-mcp "$PWD/artifacts/higgsfield-mcp-0.1.0.tgz"
~/.local/share/higgsfield-mcp/node_modules/.bin/higgsfield-mcp version
```

Install from a tagged release's tarball once one exists:

```bash
npm install --prefix ~/.local/share/higgsfield-mcp \
  https://github.com/miketropi/higgsfield-api-mcp/releases/download/v0.1.0/higgsfield-mcp-0.1.0.tgz
```

`higgsfield-mcp` with no arguments is `serve --transport stdio`, which is what the host
configuration in the [README](../README.md#3-add-it-to-your-mcp-host) launches.

## Build from source (no install)

```bash
pnpm install --frozen-lockfile
pnpm build                     # pnpm -r run build
node apps/server/dist/cli.js doctor
```

A host can also point straight at the checkout:
`node <checkout>/apps/server/dist/cli.js serve --transport stdio`.

The workspace requires the `pnpm` version in the root `packageManager` field. Installing
without `--frozen-lockfile` is not supported for release builds.

## Pack the npm tarball

```bash
# from the repository root
pnpm --filter higgsfield-mcp pack --pack-destination "$PWD/artifacts"
```

`pnpm pack` runs the package's `build` script and rewrites `workspace:*` dependency
specifiers, so the tarball installs standalone:

```bash
mkdir /tmp/hf-install && cd /tmp/hf-install
npm init -y
npm install /path/to/artifacts/higgsfield-mcp-0.1.0.tgz
./node_modules/.bin/higgsfield-mcp version
```

The published package exposes `bin.higgsfield-mcp -> ./dist/cli.js` and ships `dist` plus its
`README.md`.

## Verify the install

```bash
higgsfield-mcp version
```

prints the gateway version, the MCP protocol revision (`2026-07-28`), and the Node version.

```bash
higgsfield-mcp doctor
```

prints one `ok`/`FAIL` line per check and exits non-zero when any check fails. The checks,
in the order they are printed (`runDoctor` in `apps/server/src/cli.ts`):

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
export HF_MCP_SKILLS_DIR="$PWD/skills"
```

See [skills.md](skills.md).
