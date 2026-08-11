# 003: Bun as the runtime

Status: **done.** Bun runs the code in dev and in prod. pnpm still installs it. The decision is in
`docs/adrs/0004-bun-runtime-pnpm-packages.md`; this file records what running it produced.

Prod is on `f4b4c4e` off `feat/bun-runtime`. **Redeploy from `main` once the PR merges.**

Mastra supports pnpm workspaces and lists Bun workspaces as partial, so the lockfile, the workspace
protocol, and `mastra build`'s package-manager detection are untouched. Out of scope: `bun install`,
Bun workspaces, `bun test`, `Bun.sql` in place of `pg`, and building off-box.

## Baseline, taken before any change

Local, Node 24.15.0: ready 790ms, unauth 401, agents `["weather-agent"]`, a real forecast through
`weatherTool`, Postgres 2 threads / 6 messages, ClickHouse 6 trace roots.

Prod, Node 24.19.0: ingress 302 to Access, 4 containers up, **1 thread / 2 messages**, commit
`f2a1384`. That commit was the rollback target, picked over `main`'s tip because it had 43 hours of
uptime and `main`'s tip had never been deployed.

## Stages

| # | Stage | Commit |
| --- | --- | --- |
| 1 | Baseline smoke on Node | none, measurement |
| 2 | ADR 0004 + CONTEXT.md | `a9506de` |
| 3 | Local dev on Bun | `739400b` |
| 4 | Container on Bun | `f4b4c4e` |
| 5 | Deploy to the VPS | none |
| 6 | This document | see below |

### Stage 3: local dev

`bun --bun run dev` from `apps/agent`: ready 712ms, smoke matched baseline, messages 6 → 8, trace
roots 6 → 7. `@types/bun` went into the root manifest, `apps/agent/tsconfig.json` moved to
`"types": ["bun"]`. No source changes: `import process from 'node:process'` works on both runtimes.

`ps` prints `node` for the dev server, so the proof came from `lsof` on the 4111 listener resolving
to `/Users/abdirahmanhaji/.bun/bin/bun`.

### Stage 4: the container

Both Dockerfile stages moved to `oven/bun:1.3.14-alpine`. Exact pin, because `deploy.sh` builds on
the box and a floating tag would change Bun with nothing in the repo to point at.

**Getting pnpm into the image took three tries.** The image has no npm and no corepack, so pnpm has
to arrive as the `@pnpm/exe` binary, pinned to the root `packageManager` field.

| Attempt | Result |
| --- | --- |
| `curl get.pnpm.io/install.sh` | segfaults during setup |
| `bun install -g pnpm@11.20.0`, the JS build | needs `node:sqlite`, which Bun 1.3.14 lacks |
| `bun install -g @pnpm/exe@11.20.0` | works, but bun links the binary without an exec bit |

Hence the `chmod +x "$(readlink -f /usr/local/bin/pnpm)"` after the install. Reading the symlink
instead of hardcoding bun's global path means a layout change breaks loudly.

**Builds on Apple Silicon need `--platform=linux/amd64`.** pnpm's static arm64 binary segfaults under
Alpine, on plain `alpine` as well as `oven/bun`, so it is the binary, not the base image. amd64 is
the VPS's architecture anyway.

On the built image: `bun --version` and `process.versions.bun` both 1.3.14, `id` is uid 1000 `bun`,
`/app/studio/index.html` present, and a bare `docker run` reaches `Missing required env var:
API_TOKEN`, which proves `index.mjs` runs. Image **377MB**, down from 460MB.

Then the container against the live dev databases on `jamis_default`, before the VPS saw anything:
401 unauth, `["weather-agent"]`, a real Chicago forecast, Postgres 2 → 3 threads and 8 → 10 messages,
ClickHouse 7 → 8 trace roots. Studio's assets served 200 with the right content types, and Studio
rendered in a browser. curl cannot check that last one, and `USER bun` could have broken it.

### Stage 5: prod

Teardown kept both volumes. Deploy was
`JAMIS_BRANCH=feat/bun-runtime JAMIS_HOST=... ./infra/deploy.sh`, with `free -m` sampled every 3s
from a second session.

**Peak build memory: 2526MB of 3814**, about 1.3GB spare, swap touching 127MB before falling back to
~1MB. That number replaces the deleted heap cap. Read it with one caveat: the databases were down for
this build, so a redeploy over a running Postgres and ClickHouse has 500 to 900MB less room.

After: ingress 302, unauth 401, `bun --version` 1.3.14 in the app container, a real forecast, traces
writing, and Studio rendering both threads over the tailnet. **The pre-Bun thread from 2026-08-09
survived**, threads and messages went 1/2 → 2/4, additive only.

Studio lists sessions per `resourceId`, so a thread written with `resource: smoke-operator` is not in
the default sidebar. Open it at `/agents/weather-agent/session/smoke-003-prod`.

## What running it taught us

- **Bun ignores SIGTERM as PID 1.** Found in review, then measured: `docker stop -t 15` hung the full
  timeout and exited 137, where `node:24-alpine` exited 143 at once. Every deploy and restart would
  have stalled, then killed the app mid-request. `init: true` on the prod `app` service puts
  docker-init in front to forward the signal. On the box, stop now takes 0s and exits cleanly. Any
  future Bun container needs the same line.
- **`mastra build` warns `Failed to generate package-lock.json`.** It calls npm for that file and the
  image has none. Harmless: the runtime stage copies the installed `node_modules` and never runs
  `npm install`.
- **The pnpm shim failure is silent.** Without `--bun` everything still works, just on Node. Checks
  have to show which runtime ran, not that a command exited 0.

## Follow-ups

1. **Redeploy from `main` after the PR merges.** Prod tracks `feat/bun-runtime` until then.
2. **Watch [oven-sh/bun#34924](https://github.com/oven-sh/bun/pull/34924)**, open as of 2026-08-10.
   When it ships in a `1.3` patch, restore `ENV NODE_OPTIONS=--max-old-space-size=2048` and check it
   actually aborts. Silent acceptance is the failure mode here.
3. **If build memory tightens**, try `MASTRA_CONCURRENCY` first, which caps how many expensive build
   steps run at once, then build off-box into a registry. Not by shaving `clickhouse/memory.xml`.
4. ~~`pnpm dev` runs the Mac's Node~~ **closed after the merge.** `dev`, `build`, `typecheck`, and
   `lint` now all run through `bun --bun`, so the Node escape hatch is gone on purpose.
5. **`Bun.sql` in place of `pg`** is worth revisiting now the runtime is settled.
