# Bun installs too

Bun is now the installer as well as the runtime. `pnpm-lock.yaml` and `pnpm-workspace.yaml` are gone, `bun.lock` replaces them, and the Dockerfile no longer fetches `@pnpm/exe`. This supersedes the "Why pnpm stays" section of [0004](0004-bun-runtime-pnpm-packages.md); the rest of that ADR (why Bun builds, the `node`-shim fallback, the `bun` user, the missing heap cap) still holds.

## Why this was safe to do now

0004 already found that `@mastra/deployer` reads `bun.lock` directly (`findLockFile`, `getPackageManager()`, the `bun pm pack` branch in `pack()`). What Mastra flags as partial support is Bun *workspaces*, not `bun install` generally. [0005](0005-single-package.md) removed the workspace, so that flag stopped applying before this change was made. Flattening first is what made the installer swap safe; the swap is what removes `@pnpm/exe`, its `chmod`, and the arm64 segfault.

## esbuild's postinstall, confirmed rather than assumed

`pnpm-workspace.yaml` carried `allowBuilds: esbuild: false` because an unanswered esbuild build prompt is a hard failure inside the Docker build, not just a warning. Bun has no equivalent config key, so the question was whether Bun's own default covers it.

It does. `bun install --verbose` logs `[Lifecycle Scripts] ignoring esbuild lifecycle scripts` for this dependency tree, and `bun pm untrusted` reports zero untrusted packages with scripts, both with no `trustedDependencies` field in `package.json`. esbuild ships its platform binary as an optional dependency (`@esbuild/darwin-arm64` etc.), which Bun installs through normal optional-dependency resolution independent of any lifecycle script, so the binary is present and working even with the postinstall skipped. No config was added; the default is the protection.

## Consequences

- **The Dockerfile install stage has no package-manager bootstrap.** `COPY package.json bun.lock ./`, `RUN bun install --frozen-lockfile`, `RUN bun run build`. No `@pnpm/exe`, no `chmod`, no Apple Silicon note: `docker build` with no `--platform` flag now succeeds natively on this Mac.
- **`mastra build`'s internal install also runs Bun.** The build log shows `bun install v1.3.14` where it previously ran pnpm. The `Failed to generate package-lock.json` warning from 0004/plan 003 is still there and is expected to stay: it comes from `mastra build` shelling out to `npm` for a deploy-fallback lockfile, and the image has no `npm` binary regardless of which tool did the real install.
- **The `packageManager` field is gone.** It pinned a pnpm version; there is nothing in Bun's project config that plays the same role, and none was added.
- **Image size dropped.** `docker save`/`docker inspect --format='{{.Size}}'`/`docker images` CONTENT SIZE all undercount here, the same buildx attestation-manifest issue noted for PR 1, worse now that `--provenance=false` no longer routes around it either. `docker history`'s summed layer sizes and `du -sh /` inside a running container agree with each other (~290-305MB) and land clearly under the 377MB baseline from plan 003, consistent with dropping the `@pnpm/exe` binary and its own install footprint.
