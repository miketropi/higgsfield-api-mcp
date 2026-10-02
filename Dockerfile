# Higgsfield MCP gateway image.
#
#   docker build -t higgsfield-mcp:local .
#   docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
#     -e HF_MCP_DATABASE_URL=... -e HF_MCP_REDIS_URL=... \
#     -p 127.0.0.1:3000:3000 higgsfield-mcp:local
#
# Design notes (see docs/deployment.md for the operator view):
#   * Multi-stage: the build stage installs from the committed `pnpm-lock.yaml`
#     with the pnpm version pinned by the root `packageManager` field (corepack)
#     and builds every workspace project; the runtime stage carries only the
#     production dependency closure plus `apps/server/dist`.
#   * Internal `@higgsfield-mcp/*` packages are bundled into `apps/server/dist/cli.js`
#     (see apps/server/tsup.config.ts `noExternal`), so the CLI is a single entry point.
#   * No credential is baked into any layer: every provider/DB/Redis/S3 secret is
#     read from the environment at run time, and `.env` files are excluded by
#     .dockerignore.
#   * The image is built for a read-only root filesystem: it writes nothing
#     outside `/tmp` (scratch, mounted as tmpfs) and the S3 object store.

# Base image pinned by digest. Resolved from Docker Hub on 2026-10-02 with
#   GET https://registry-1.docker.io/v2/library/node/manifests/22-slim
#   docker-content-digest: sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
# (multi-arch index covering linux/amd64, linux/arm64, linux/arm, linux/ppc64le).
ARG NODE_IMAGE=node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# ---------------------------------------------------------------- build stage
FROM ${NODE_IMAGE} AS build

ENV CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/opt/corepack \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# `corepack` ships with the Node image and activates the pnpm version declared in
# the root `package.json` (`"packageManager": "pnpm@11.13.0"`), so the toolchain
# is controlled by the repository instead of this Dockerfile.
RUN corepack enable

WORKDIR /app

# The whole workspace is copied: `pnpm install --frozen-lockfile` requires every
# project referenced by `pnpm-workspace.yaml` and the lockfile to be present.
# `.dockerignore` keeps `node_modules/`, `dist/`, `.env*` and tooling out.
COPY . .

# `allowBuilds` in pnpm-workspace.yaml gates install scripts (esbuild, protobufjs).
RUN --mount=type=cache,id=hf-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

RUN pnpm -r run build

# Replace the development tree with the production-only closure, then drop the
# TypeScript sources: the runtime resolves each package through its dist/ entry
# point (`packages/*/package.json` -> ./dist/index.js).
RUN --mount=type=cache,id=hf-pnpm-store,target=/pnpm/store,sharing=locked \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules && \
    pnpm install --frozen-lockfile --prod --store-dir=/pnpm/store

# Optional build-time assets, copied unconditionally into /out so the runtime
# stage can use a plain `COPY --from` even when a tree is absent.
#   * the generated skills tree (produced by `pnpm skills:sync`, not by the
#     build itself - it needs network access to the pinned upstream);
#   * the model catalog JSON, retained for provenance only: it is inlined into
#     dist/cli.js by the tsup JSON loader and is not read at run time;
#   * the PostgreSQL migration files. `tsup` does not copy `.sql` next to the
#     bundle, and `higgsfield-mcp migrate` searches `<dist>/migrations` first
#     (packages/core/src/jobs/postgres/migrate.ts), so the CLI can only run
#     migrations from an image that ships them there.
RUN mkdir -p /out/skills /out/models /out/migrations && \
    if [ -f skills/manifest.json ]; then \
      cp -R skills/. /out/skills/; \
      echo "build: packaged skills tree from skills/"; \
    elif [ -f packages/skills/generated/manifest.json ]; then \
      cp -R packages/skills/generated/. /out/skills/; \
      echo "build: packaged skills tree from packages/skills/generated/"; \
    else \
      echo "build: no generated skills tree at build time (run 'pnpm skills:sync' before building to include one)"; \
    fi && \
    if [ -f packages/provider-higgsfield/src/models/registry.json ]; then \
      cp packages/provider-higgsfield/src/models/registry.json /out/models/registry.json; \
      echo "build: retained model catalog for provenance"; \
    else \
      echo "build: model catalog not found (it is bundled into dist/cli.js)"; \
    fi && \
    if [ -d packages/core/src/jobs/postgres/migrations ]; then \
      cp -R packages/core/src/jobs/postgres/migrations/. /out/migrations/; \
      echo "build: staged $(ls /out/migrations | wc -l) migration file(s)"; \
    else \
      echo "build: ERROR: no migrations directory found at packages/core/src/jobs/postgres/migrations" >&2; \
      exit 1; \
    fi

# Sources are no longer needed once every artifact above is staged.
RUN rm -rf packages/*/src

# -------------------------------------------------------------- runtime stage
FROM ${NODE_IMAGE} AS runtime

ARG GATEWAY_UID=10001
ARG GATEWAY_GID=10001

ENV NODE_ENV=production \
    HF_MCP_SERVICE_NAME=higgsfield-mcp

# Non-root runtime account with an explicit, stable uid/gid so bind mounts and
# `--user` overrides are predictable.
RUN groupadd --system --gid ${GATEWAY_GID} gateway && \
    useradd --system --uid ${GATEWAY_UID} --gid ${GATEWAY_GID} \
      --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin gateway

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist

# Packaged skills resolve to `dist/skills` (apps/server/src/skills-dir.ts looks
# next to the built CLI first), so an operator-supplied HF_MCP_SKILLS_DIR is not
# required. The catalog copy is provenance only and never read at run time.
COPY --from=build /out/skills/ ./apps/server/dist/skills/
COPY --from=build /out/models/registry.json ./apps/server/dist/models/registry.json

# `higgsfield-mcp migrate` resolves migrations from `<dist>/migrations` (or the
# other bundled layouts) - packages/core/src/jobs/postgres/migrate.ts.
COPY --from=build /out/migrations/ ./apps/server/dist/migrations/

EXPOSE 3000

USER ${GATEWAY_UID}:${GATEWAY_GID}

STOPSIGNAL SIGTERM

# Non-billable probe: `GET /health` is a static response and calls no provider
# endpoint. `HF_MCP_PORT` defaults to 3000 when unset (packages/config defaults).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HF_MCP_PORT || 3000) + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

# `serve --transport http` from the bundled CLI; host 0.0.0.0 is required inside
# a container. Port comes from HF_MCP_PORT (default 3000).
CMD ["node", "apps/server/dist/cli.js", "serve", "--transport", "http", "--host", "0.0.0.0"]
