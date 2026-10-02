# Contributing

## Layout and ownership

| Path | Owns |
|---|---|
| `packages/core` | Contracts and domain services. |
| `packages/config` | Environment/file configuration, validation, defaults. |
| `packages/mcp` | The frozen MCP wire contract (tool schemas, serializer, resources). |
| `packages/observability` | Logger, metrics, tracing. |
| `packages/provider-higgsfield` | Provider HTTP client, path guards, mapping, model catalog. |
| `packages/skills` | Skill adapter, manifest, patching, validation, drift check. |
| `apps/server` | The published `higgsfield-mcp` binary and its composition root. |
| `skills/` | The generated, checked-in skills tree. |
| `tests/` | Unit, contract, integration, and skills tests. |
| `scripts/e2e` | The end-to-end harness. |
| `docs/`, `README.md`, `SPEC.md` | Documentation and the product specification. |

`packages/core/src/contracts.ts` and `packages/config/src/types.ts` are **frozen**: they are
the only cross-package interfaces, and changing either is an architectural change rather than
a local edit. `SPEC.md` is the product specification; when code and spec disagree, that is a
bug to raise, not a doc to quietly rewrite.

## Root scripts

| Script | Runs |
|---|---|
| `pnpm build` | `pnpm -r run build` (tsup per package, bundling `@higgsfield-mcp/*` into the CLI). |
| `pnpm typecheck` | `pnpm -r run typecheck` plus `tsc -p tsconfig.tests.json` for `tests/**` and `scripts/**`. |
| `pnpm test` | `vitest run` over every `tests/**/*.test.ts`. |
| `pnpm test:unit` | `vitest run tests/unit`. |
| `pnpm test:contract` | `vitest run tests/contract`. |
| `pnpm test:integration` | `vitest run tests/integration`. |
| `pnpm test:e2e` | `tsx scripts/e2e/cli.ts` — see below. |
| `pnpm skills:sync` / `skills:validate` / `skills:check-upstream` | Delegate to the skills package. |
| `pnpm migrate` | `pnpm --filter higgsfield-mcp run migrate`. |

`vitest.config.ts` aliases every `@higgsfield-mcp/*` import to `packages/*/src/index.ts`, so
tests run against source without a build. Tests run in the `node` environment with a 30 s
test timeout, a 60 s hook timeout, and `pool: 'forks'`.

## Test levels

Mirroring SPEC §55:

| Level | Path | Covers |
|---|---|---|
| Unit | `tests/unit/{config,core,mcp,media,observability,server,skills}` | Schema validation, routing, cost rules, path and URL validation, error mapping, tool-layer behavior, skill patching. |
| Contract | `tests/contract/provider` | A mocked provider: request body, auth header, idempotency key, polling, error mapping, catalog integrity. |
| MCP integration | `tests/integration` (`protocol`, `isolation`, `replay`, `reliability/*`) | A real MCP server driven through `tools/list`, `tools/call`, `resources/list`, `resources/read`, plus tenant isolation, replay, migration, PostgreSQL, and Redis reliability. |
| Skills | `tests/skills` | Skill trace evaluation and injected-failure handling. |
| E2E (paid, opt-in) | `scripts/e2e` | The distribution and live profiles below. Paid E2E never runs on every pull request. |

The integration and reliability suites need PostgreSQL and Redis; `tests/integration/harness`
and `tests/fixtures` provide the shared helpers and doubles.

## End-to-end harness

`scripts/e2e/cli.ts` is dependency-free (Node standard library, the repo's `tsx`, and the MCP
client SDK that is already a root devDependency). It is safe to re-run and always cleans up
only the resources it created.

```bash
pnpm test:e2e -- --profile distribution   # default
pnpm test:e2e -- --profile live
```

An unknown `--profile` value prints usage and exits 2.

**`distribution`** builds the workspace, packs the tarball with
`pnpm --filter higgsfield-mcp pack --pack-destination <repo>/artifacts`, installs it into a
disposable directory with an isolated npm cache, and then:

1. asserts the packed tree carries no `workspace:` specifier and that every bare import
   resolves inside the install directory (never back into the monorepo);
2. runs `version` and `doctor` from the installed package;
3. drives stdio discovery with the real MCP client: 14 tools, models and capabilities calls,
   resource listing;
4. proves the stdio stream carries only protocol traffic: it speaks raw newline-delimited
   JSON-RPC to the CLI over pipes (initialize, then a real `tools/list`), asserts every
   stdout line is a JSON-RPC 2.0 frame with no log record among them, and asserts the
   process logged structured records to stderr;
5. builds the container image and asserts the configured user is non-root;
6. starts `postgres`, `redis` and the object-store service from `docker-compose.yml` with
   generated throwaway secrets (so no local `.env` is required), publishing them on
   OS-assigned host ports so a locally running PostgreSQL or Redis cannot collide, and
   discovering the service names, the compose project network, and the credentials from the
   running containers;
7. runs the shipped image read-only, non-root, with a `/tmp` tmpfs, applies migrations, and
   checks `/health`, `/ready`, `/metrics` (401 without the token, 200 with it), the read-only
   root filesystem, and the runtime uid;
8. submits an image generation over HTTP MCP against a local fixture provider, SIGTERMs the
   container and restarts it, then proves the job survived, completes, and its asset is
   readable through `higgsfield.media.get`;
9. rejects an unauthenticated `POST /mcp`.

**`live`** is the only profile that may spend money. It refuses to run without
`HF_MCP_LIVE_E2E=1`, `HF_API_CREDENTIALS`, and a positive `HF_MCP_LIVE_MAX_USD`, and it prices
every paid call through the gateway's own confirmation flow
(`HF_MCP_REQUIRE_CONFIRM_ABOVE_USD=0`), aborting before any call whose estimate would exceed
the remaining budget. It exercises image generation, image edit, image-to-video, output
retrieval, and queued cancellation; Soul ID training runs only with `HF_MCP_LIVE_SOUL=1` and
`HF_MCP_LIVE_SOUL_IMAGE_URL`. Without the guard variables it prints
`live validation not run: …` and exits non-zero.

Harness knobs (documented in the file header): `HF_MCP_E2E_SKIP_DOCKER=1` records the
container gate as skipped instead of failed, `HF_MCP_E2E_PORT` sets the published gateway port
(default 3199), and `HF_MCP_E2E_BIN` overrides the CLI the live profile drives.

## Coding conventions

- **Strict TypeScript.** `tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `noUnusedLocals`, `noUnusedParameters`, `useUnknownInCatchVariables`, and
  `verbatimModuleSyntax`. Optional properties are declared `?: T | undefined` so
  `exactOptionalPropertyTypes` stays usable.
- **snake_case only at the MCP boundary.** Everything internal is camelCase; the translation
  lives in `packages/mcp/src/serialize.ts` and nowhere else.
- **Money is integer micro-USD.** Parsing provider decimals uses exact decimal arithmetic;
  rounding money silently is treated as a bug.
- **No credential material on jobs, assets, logs, or MCP responses.** Use the shared
  redaction helpers rather than ad-hoc scrubbing.
- **Fail fast on configuration.** Collect every problem and throw one
  `ConfigValidationError` naming each path.
- **Pure provider preparation.** `prepare()` is deterministic and network-free; the exact
  request body and its hash are persisted before the first POST so a replay is byte-identical.
- **No new dependencies for tooling** unless the task genuinely requires one; the e2e harness
  in particular must stay on Node built-ins plus existing devDependencies.

## Continuous integration

`.github/workflows/` contains three workflows:

| Workflow | Trigger | Jobs |
|---|---|---|
| `CI` | pull requests and pushes | `checks` (install with the frozen lockfile, typecheck, unit, contract, integration, skills validation), `audit` (dependency audit), `docker` (container build). |
| `Release` | tag push | `build` (artifacts, SBOM) then `publish`, which is approval-gated and never runs on a pull request. |
| `Skills drift` | schedule | `check-upstream`, which reports the pinned commit, the upstream head, and the upstream version, and opens a compatibility pull request when the pin is stale — never auto-merging. |

No workflow performs a paid generation or uses live provider credentials.

## Local workflow

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test:unit
pnpm test:integration     # needs PostgreSQL and Redis
```
