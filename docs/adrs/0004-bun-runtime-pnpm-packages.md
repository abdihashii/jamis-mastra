# Runtime: Bun executes, pnpm installs

Bun runs the code: `mastra dev` locally, `bun index.mjs` in the container. pnpm stays the package manager. Both Docker stages use `oven/bun:1.3.14-alpine`.

The tag is an exact pin, like the ClickHouse one. `deploy.sh` builds on the box, so a floating tag would let a redeploy change Bun patch versions with nothing in the repo to point at.

## Why pnpm stays

Mastra lists Bun *workspaces* as partial support with known issues, not Bun installs generally. `@mastra/deployer` already reads `bun.lock`: `findLockFile` includes it, `getPackageManager()` returns `"bun"`, and `pack()` has a `bun pm pack` branch. `mastra build` picks its install command from the lockfile name, so the lockfile matters at build time too. Switching to `bun install` would drop a workspace layout Mastra flags, not an install method it lacks.

## Why Bun builds, not just runs

Mastra's bundler sets `platform = process.versions?.bun ? "neutral" : "node"`. Module resolution is the same either way (`preferBuiltins: true`, `exportConditions: ["node"]`), though `platform` is also threaded into the esbuild transform. Its documented purpose is preserving Bun globals like `Bun.s3`.

Nothing here uses `Bun.*` yet, so a Node build would work today. It would break the first time someone used `Bun.sql`, and only inside the Docker build. Building on the runtime we deploy on avoids that, and avoids keeping Node alive for every future package.

## How the image runs Node-shaped tooling

pnpm's `node_modules/.bin/*` entries are shell shims ending in `exec node ...`, so they call `node` by name whatever started them. `oven/bun:1.3-alpine` handles this itself: it ships `/usr/local/bun-node-fallback-bin/node`, a symlink to `bun`, on the default `PATH`. The shims resolve to Bun with no help from us, so **no `node` symlink is added to the Dockerfile**.

That wrapper runs scripts only. `node --version` fails with "Bun's provided 'node' cli wrapper does not support a repl", so it cannot be used to check which runtime an image has. Use `bun --version`, or print `process.versions.bun` from a script.

Locally the shims still find the Mac's real Node, so dev needs `bun --bun run dev`, which points `node` at Bun for one script.

Getting this wrong is silent: on the Mac, `pnpm dev` runs fine on Node and looks identical. Checks must prove which runtime ran, not that the command exited 0.

`corepack enable` is gone, since corepack is a Node tool. `oven/bun` ships no npm or pnpm either, so the build stage installs the `@pnpm/exe` binary itself, then `chmod +x`es it, since bun links global binaries without an exec bit. Both alternatives fail in this image: `get.pnpm.io/install.sh` segfaults, and the JS build of pnpm 11 needs `node:sqlite`, which Bun 1.3.14 lacks.

## Consequences

- **The base image has no `node` user.** `oven/bun:1.3-alpine` has only `bun` (uid 1000). `COPY --chown=node:node` and `USER node` fail outright, so both move to `bun`. This is the one change that breaks the build immediately rather than subtly.
- **No build-time heap cap, and nothing replaces it.** `NODE_OPTIONS=--max-old-space-size=2048` bounded Rollup so an on-box build could not get ClickHouse OOM-killed on the 4GB box. Bun accepts the flag and ignores it (oven-sh/bun#34917); `BUN_JSC_forceRAMSize`, `gcMaxHeapSize`, and `--smol` are not substitutes. The 4GB swapfile and the 1.5GB `max_server_memory_usage` predate the cap and do not bound a growing process: swap only delays the OOM killer, which still picks the largest RSS. Accepted as a risk, not as coverage. oven-sh/bun#34924 would implement the flag but is open and unmerged as of 2026-08-09, so treat it as a thing to watch, not a plan.
- **Bun ignores SIGTERM as PID 1**, so a container running it directly hangs until the stop timeout, then gets killed. Measured at 15s and exit 137, against 143 at once on `node:24-alpine`. The prod `app` service sets `init: true` to put docker-init in front. Any future Bun container needs the same.
- **Every script carries `bun --bun`.** `dev`, `build`, `typecheck`, and `lint` all start with it, so `pnpm dev` runs on Bun without anyone remembering to. Dropping the prefix silently falls back to the Mac's Node, which is why it is in the scripts rather than in a habit.
- **Builds on Apple Silicon need `--platform=linux/amd64`.** pnpm's static arm64 binary segfaults under Alpine, on plain `alpine` too. amd64 is the VPS's architecture anyway, so the cost is emulation time.
- **`@types/bun` is a root dependency.** `@types/node` sits in the root `package.json`, not in `apps/agent`, which resolves it by hoisting. Switching `apps/agent/tsconfig.json` to `"types": ["bun"]` without adding `@types/bun` to the root manifest fails typecheck.
- **New workspace packages still need a `COPY <pkg>/package.json` line** in the Dockerfile. The whole-workspace install behind it now runs on a pnpm binary the image fetches.
