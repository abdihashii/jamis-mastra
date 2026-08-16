FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app

# Manifest first so a source-only change reuses the install layer.
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY src src
COPY tsconfig.json ./
# Rollup holds the whole module graph in memory and deploys build on the box with
# postgres and clickhouse running, but bun silently ignores
# --max-old-space-size (oven-sh/bun#34917), so the heap cap that used to sit here
# is gone. The 4GB swapfile and clickhouse's 1.5GB max_server_memory_usage are
# the only guards left, and neither bounds a growing process: a runaway build
# still gets clickhouse OOM-killed. Accepted risk until bun#34924 lands.
RUN bun run build

FROM oven/bun:1.3.14-alpine
WORKDIR /app

# mastra build emits a self-contained output dir: index.mjs, its own
# node_modules, and the studio assets. No MASTRA_STUDIO_PATH needed: it defaults
# to <dir of index.mjs>/studio, which is /app/studio.
COPY --from=build --chown=bun:bun /app/.mastra/output ./

USER bun
EXPOSE 4111
CMD ["bun", "index.mjs"]
