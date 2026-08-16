# Single package, not a workspace

The repo is one `package.json` at the root. `apps/` and `packages/` are gone; `src/`, `clickhouse/`, the Dockerfile, both compose files, `tsconfig.json`, and the env dotfiles all moved to the repo root.

## Why the workspace went away

- **`packages/` was empty and `apps/` held exactly one thing.** Every line of plan 002 (the supervisor agent, iMessage channel) was always going to land in that same app. A workspace earns its cost by splitting code across packages; this one never did.
- **The split cost a second manifest and a Dockerfile COPY line per package.** `apps/agent/package.json` duplicated `type: module` and carried its own scripts; the Dockerfile needed `COPY apps/agent/package.json apps/agent/` ahead of `pnpm install` so the install layer could cache independently of source changes.
- **`zod` at the root forced a whole-workspace install.** `zod` lived in the root manifest but was imported only from `apps/agent/src`, so `pnpm install --filter @jamis-mastra/agent...` in the Dockerfile skipped the root project and failed resolving it. The fix in place was installing the whole workspace instead of filtering, which meant the build stage also carried the root devDependencies (eslint, typescript) for no benefit. Flattening removes the whole category of bug: there is one manifest, so there is nothing to filter.

## What moved, what didn't

Everything under `apps/agent` moved to the repo root via `git mv`, byte-identical. The two manifests merged into one: `type: module`, the five `@mastra/*` dependencies, and the `mastra` devDependency came from the agent manifest; `zod` and the eslint/typescript devDependencies stayed from the root. `pnpm-workspace.yaml` keeps `shellEmulator`, `trustPolicy`, and `allowBuilds: esbuild: false` (still load-bearing: pnpm still installs until the next ADR), and drops only its `packages:` key.

## What reintroducing a package would cost

The next genuinely shared package (not "the agent, but split for its own sake") would need:

- `packages:` back in `pnpm-workspace.yaml` (or, once installs move to Bun, a Bun workspace, which Mastra lists as partial support with known issues rather than the pnpm workspace's full support, per [0004](0004-bun-runtime-pnpm-packages.md))
- A per-package `package.json`, and a `COPY <pkg>/package.json` line in the Dockerfile ahead of the install step, undoing the simplification this ADR makes
- A decision on where shared deps like `zod` live, since hoisting from the root manifest is exactly the quirk that made the single-package Dockerfile simpler

None of that is hard, it is the same shape the repo had before this change. The point of flattening is not paying that cost until a second package actually exists.

## Consequences

- **The Dockerfile has no per-package COPY line and no `-F` filter.** `pnpm install --frozen-lockfile` and `pnpm run build` are unconditionally whole-repo, because the whole repo is one package.
- **`mcp__mastra__searchMastraDocs`'s `projectPath` moves to the repo root.** It used to point at `apps/agent`.
- **Historical docs (plans 001 and 003) keep their `apps/agent` paths.** They describe what was true when they were written and are not rewritten.
