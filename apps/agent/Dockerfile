# Build context is the repo root, not this directory: the build stage needs the
# workspace manifest and the lockfile.
#
#   docker build -f apps/agent/Dockerfile -t jamis-agent .

FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app

# Manifests first so a source-only change reuses the install layer. Add a COPY
# line here for every new workspace package.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/agent/package.json apps/agent/

# Whole workspace, not --filter @jamis-mastra/agent...: zod lives in the root
# package.json and a filtered install skips the root project, so the bundle step
# would fail resolving it.
RUN pnpm install --frozen-lockfile

COPY apps/agent apps/agent
# Rollup holds the whole module graph in memory. Deploys build on the box, where
# postgres and clickhouse are already running, so this stays well under the
# CX23's 4GB: at the full 4GB the OOM killer would pick the largest process,
# which is clickhouse, and take the database down mid-deploy.
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN pnpm -F @jamis-mastra/agent build

FROM node:24-alpine
WORKDIR /app

# mastra build emits a self-contained output dir: index.mjs, its own
# node_modules, and the studio assets. The server finds the assets on its own:
# MASTRA_STUDIO_PATH defaults to <dir of index.mjs>/studio, which is /app/studio.
COPY --from=build --chown=node:node /app/apps/agent/.mastra/output ./

USER node
EXPOSE 4111
CMD ["node", "index.mjs"]
