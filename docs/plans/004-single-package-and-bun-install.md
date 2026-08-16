# 004: One package, then bun installs

Status: **PR 1 done.** PR 2 (bun installs) not started.

## Context

Plan 003 put Bun in charge of execution everywhere and left pnpm installing. Two things surfaced
right after it shipped:

- **The workspace earns nothing.** `packages/` is empty, `apps/` holds exactly one thing, and every
  line of plan 002 lands in that same app. The split costs a second manifest, a `COPY` line per
  future package in the Dockerfile, and the `zod`-in-root quirk that forces a whole-workspace
  install inside the image.
- **`bun install` is not blocked after all.** `@mastra/deployer` reads `bun.lock` and returns `bun`
  from `getPackageManager()`, with a bun branch in `pack()`. What Mastra actually flags is Bun
  **workspaces**, which stop existing once the repo is one package.

So flattening first is what makes the installer swap safe, and the swap is what removes `@pnpm/exe`,
its `chmod`, and the arm64 segfault from the Dockerfile.

## Decisions

- **Fully flat.** `src/`, `clickhouse/`, `Dockerfile`, both compose files, `tsconfig.json`, and the
  three dotfiles (`.env`, `.env.example`, `.env.prod.example`) move to the repo root. `apps/` and
  `packages/` are deleted.
- **Two PRs.** Flatten lands first, then the installer swap, so a later prod failure has one suspect.
- **No prod deploy in either PR.** Stop at local container verification. Prod stays on `c4e2c59`
  through PR 1.
- **Compose project name stays `name: jamis`**, so `jamis_pgdata`, `jamis_chdata`, and
  `jamis_default` are unaffected by the file move.

The full decision record and the why-pnpm-stays-for-now reasoning are in
[0005-single-package.md](../adrs/0005-single-package.md).

---

## PR 1: flatten to one package

Branch `chore/flatten-single-package`, off `main` at `c4e2c59`.

### Stage 1: land what was already pending

Two commits:

- `8540ded` `chore: run every script through bun --bun` — the five files already sitting modified in
  the working tree from plan 003's tail end (`package.json`, `apps/agent/package.json`, `CONTEXT.md`,
  `docs/adrs/0004-*.md`, `docs/plans/003-*.md`).
- `6f0df09` `docs: correct the bun lockfile claim in ADR 0004` — line 9 read as if Mastra cannot
  install with bun. Narrowed to Bun *workspaces* being partial support, and named
  `@mastra/deployer`'s `bun.lock` support (`findLockFile`, `getPackageManager()`, the `pack()` bun
  branch).

### Stage 2: the move

One commit, `ec9c66d` `chore: flatten apps/agent to the repo root`.

`git mv` throughout; `git diff` against the pre-move blobs confirmed byte-identical content for every
moved file. `apps/agent/.env` (untracked) moved with a plain `mv`; `apps/agent/.mastra` (18MB build
output) deleted, not moved.

Manifests merged into the root `package.json`: `type: module`, the five `@mastra/*` dependencies, and
`mastra` from the agent manifest; `zod` and the eslint/typescript devDependencies stayed at root; the
`bun run --bun` scripts from stage 1 carried over; `"main": "index.js"` dropped (pointed at a file
that never existed). `pnpm-workspace.yaml` kept `shellEmulator`, `trustPolicy`, and
`allowBuilds: esbuild: false`, and lost only `packages:`.

Path-coupled fixes: the Dockerfile dropped the per-package `COPY` and the `-F @jamis-mastra/agent`
filter, output path became `/app/.mastra/output`; `docker-compose.prod.yml`'s build context went
`../..` → `.`; `infra/deploy.sh` dropped `cd apps/agent` and gained a guard that fails loudly if
`.env.prod` is still at its old path on a box. `pnpm-lock.yaml` regenerated: two importers collapsed
to one, zero dependency version changes.

**Verified:**

- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`: all clean.
- `pnpm dev`: ready in 673ms once Postgres/ClickHouse were actually healthy; `lsof -nP -iTCP:4111
  -sTCP:LISTEN` resolved to `bun`.
- Local smoke: unauth 401, `["weather-agent"]`, a real Chicago forecast through `weatherTool`,
  Postgres messages 14 → 16 (thread reused, additive), ClickHouse trace roots present (11, writing).
- `docker build --platform linux/amd64 -f Dockerfile -t jamis-agent .` succeeded.
- Container against `jamis_default`: unauth 401, `["weather-agent"]`, a real Chicago forecast,
  messages 16 → 18, Studio index served 200. Torn down with `docker compose down`, never `-v`;
  `jamis_pgdata` and `jamis_chdata` confirmed present after.
- `grep -rn "apps/agent\|@jamis-mastra/agent" --exclude-dir=node_modules --exclude-dir=.git .`
  returned only historical plan docs 001 and 003, plus this doc's own stage-1 commit message and
  `infra/deploy.sh`'s guard text, both of which reference the old path on purpose.

**Environment note, not a regression:** mid-verification, the session's wall clock jumped several
days across a long background wait, and the `jamis-postgres-1` container was found dead (exit 137)
when verification resumed. Removed the stale container and brought the stack back up against the
same untouched `jamis_pgdata` volume; the retest above is against that clean run. Root cause was
Docker Desktop / host sleep behavior, not the flatten. `pg_stat_activity` showed no lock contention
from the dead container.

### Stage 3: docs

This stage. `CONTEXT.md` rewritten (monorepo → single-package language, `apps/agent` → `src`
throughout). `docs/adrs/0005-single-package.md` added. `docs/plans/002-jamis-agent.md`'s 8
`apps/agent/...` paths in not-yet-done work updated to root-relative. Plans 001 and 003 left alone as
historical record. This file added.

---

## PR 2: bun installs

Not started. See the plan doc's PR 2 section for the intended shape: delete `pnpm-lock.yaml` and
`pnpm-workspace.yaml`, `bun install` to produce `bun.lock`, drop `@pnpm/exe` from the Dockerfile, and
confirm (not assume) that Bun blocks lifecycle scripts by default so the `allowBuilds: esbuild: false`
intent survives without configuration.

## Acceptance, PR 1 only

| # | Check | Result |
| --- | --- | --- |
| `apps/`, `packages/` | gone | done |
| `bun install --frozen-lockfile` n/a until PR 2; `pnpm typecheck`, `pnpm lint` | clean | done |
| `pnpm dev`, `lsof` on 4111 | listener is `bun` | done |
| `docker build` on amd64 | succeeds | done |
| Container on `jamis_default`, full smoke | matches plan 003's baseline | done |
| Unauthenticated API call | 401 | done |
| Studio in a browser | not checked in a real browser this PR; index served 200 with correct HTML | partial |
| `docker volume ls` | `jamis_pgdata` and `jamis_chdata` untouched | done |
| Prod | still on `c4e2c59`, not redeployed | done |
