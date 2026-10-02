# 027: Read-only Project understanding (JAM-79)

Status: planned; implementation has not started.

Scope and acceptance criteria: [JAM-79](https://linear.app/abdirahman-haji/issue/JAM-79/let-jamis-read-approved-project-files). This plan implements the ticket; it does not expand its scope.

## Verified starting point

- The Operator's directory listings place the checkout at `/root/jamis-mastra` and confirm an existing host `jamis` account. `/root` is root-only. Live container identity and mount permissions still require verification.
- `Dockerfile` configures non-root `bun`. The production Compose overlay currently mounts private runtime data and the fixed host-evidence socket, but no approved project view.
- Installed `@mastra/core@1.71.0` provides `Workspace`, contained/read-only `LocalFilesystem`, and native list/read/grep/stat tools. A static read-only filesystem excludes mutation tools; no sandbox is needed.
- `src/mastra/agents/jamis.ts` directly owns Monitoring and Incident triage, with public research delegated separately. Project access must fit those existing routes.
- `docs/CONTEXT.md` defines Project understanding. The native Workspace choice is reversible and needs no separate ADR.

## Implementation approach

Expose a dedicated absolute project root, containing only the directories and exact files approved in JAM-79. Prepare a filtered view from the current checkout for both development and production; mount that view read-only in production. Do not mount raw source trees or expand `allowedPaths` to the repository, application data, or host filesystem.

Use Compose long-form bind mounts with `read_only: true` and `bind.create_host_path: false`, so a missing source is not silently replaced by an empty directory. Preserve repository-relative names in the project view. Read-only mounts prevent modification; Mastra containment prevents project tools from reaching other application-visible files, including existing runtime credentials.

Use one preparation command and fixed selection for both environments. Apply explicit exclusions recursively: environment/credential files and backups, private runtime directories, SQLite/DuckDB files and their sidecars, Git internals, dependencies, generated runtime artifacts, and research artifacts. Existing `src/mastra/public/mastra.db*` and `mastra.duckdb*` contain local memory; `.dockerignore` does not filter files copied into a view. Preserve symlinks without following them during preparation, and reject reads whose resolved targets escape the approved view. Validate a fresh view before publishing it so regeneration cannot retain old excluded files.

Refresh the view whenever the supported workflow changes the checkout, including manual source edits before inspection. After publishing a replacement view during deployment, force recreation of the `app` container without forcing recreation of the databases or other services. A file or directory bind can retain an old inode after replacement; ordinary `compose up -d --build` does not guarantee recreation when image/configuration is unchanged. The view is prepared from current checkout files, not from a source snapshot tied to the running build. Record its preparation time and do not claim an unrefreshed view proves the latest checkout contents. Avoid a watcher or custom filesystem provider.

Create a small Workspace configuration module using existing Mastra imports, an absolute view path, `readOnly: true`, and `contained: true`. Configure no sandbox, indexing service, custom file tools, or new dependency. A missing or unconfigured view must not silently become an unrestricted repository filesystem or prevent unrelated Jamis requests.

## 1. Establish and prove the file boundary

**Goal:** Approved files are readable through native tools, while excluded paths and writes are rejected, before Jamis receives the capability.

**Critical files:**

- `docker-compose.prod.yml`: the filtered read-only view mount and its absolute location.
- `infra/deploy.sh`: view preparation after checkout updates and forced recreation of only `app` after view publication.
- `src/mastra/project-workspace.ts`: native Workspace setup and approved material selection.
- `scripts/prepare-project-view.ts`, `package.json`, and `.gitignore`: shared filtered-view preparation, its runnable command, and generated-view exclusion.
- One focused Bun check for the configured view and native tool set, plus a disposable Linux container smoke for mount enforcement.

**Verification:**

- Read a known source file and selected configuration file; list and search approved content.
- Reject excluded-path and traversal requests. Exercise symlinks to excluded files, including a target outside the project view that is otherwise readable by the application.
- Place synthetic environment files, credential backups, runtime directories, SQLite/DuckDB files, and sidecars inside an approved source directory. Verify preparation excludes them, native tools cannot list/search/read them, and regeneration removes any stale excluded entries.
- Prove native writes fail and that mutation/command tools are absent.
- In a disposable container running as the application UID, prove an approved-file read succeeds and a write to a disposable mounted fixture fails at the filesystem boundary. Use synthetic credential fixtures, not production credential contents.
- Exercise missing-view, missing-file, and partial-search outcomes. Verify no fallback to the full repository.
- Atomically replace an approved checkout file, refresh the view, and exercise the deployment recreation path with an unchanged app image. Verify container file reads return the replacement content and other services are not recreated.
- Run `bun run typecheck`, `bun test`, `bun run lint`, and `bun run build`.

**Demoable acceptance:** The focused check reads the expected approved fixture and reports rejection of excluded paths and writes; the container smoke independently rejects a write to the mounted fixture.

Contract sources: [Mastra LocalFilesystem](https://mastra.ai/reference/workspace/local-filesystem), [Workspace](https://mastra.ai/reference/workspace/workspace-class), [Compose bind options](https://docs.docker.com/reference/compose-file/services/#long-syntax-6), and [Compose recreation behavior](https://docs.docker.com/reference/cli/docker/compose/up/). File-replacement behavior is also documented in this [confirmed bind-mount fix](https://github.com/samnet-dev/mtproxymax/pull/134).

**Proposed commit:** `feat: add a contained read-only project workspace`.

Stop for Operator sign-off before committing or proceeding to Stage 2.

## 2. Attach the capability and verify the Operator experience

**Goal:** Plain-English Operator requests inspect approved files and return grounded answers through the existing Jamis conversation.

**Critical files:** `src/mastra/agents/jamis.ts`, focused integration checks using existing test patterns, and this delivery record.

**Implementation:** Attach the native Workspace directly to Jamis. Add concise guidance for explicit project requests, ambiguous requests, file references, untrusted file contents, partial results, and checkout-versus-runtime evidence. Preserve the existing Monitoring, Incident triage, and Online research routes. Do not introduce another agent, classifier, or command prefix.

**Verification:**

- Exercise representative requests to list, search, and explain approved files, plus denied and missing-file requests. Verify answers reference retrieved files without implying that checkout content proves the running build.
- Use a controlled file containing an instruction-like passage to verify it is treated as source evidence, not authorization.
- Verify existing Monitoring requests retain their route. Natural-language routing checks demonstrate observed behavior, not deterministic intent recognition.
- Re-run the full typecheck/test/lint/build gate. Report totals and the final committed-stage list.

**Demoable acceptance after authorized deployment:** Through iMessage, ask Jamis to read and explain the incoming-message handler, then verify its file references against the current checkout. Exercise listing/search, a denied credential-file request, and existing Monitoring. Verify live non-root identity and read-only mounts using metadata; never read real credential contents for the smoke.

**Proposed commit:** `feat: let Jamis inspect approved project files`.

Stop for Operator sign-off before committing. Push and deployment each require separate authorization. When the Operator runs live checks, guide one command or observation at a time and wait for the result.

## Evidence to record during delivery

Record gate totals, fixture/container check results, stage commits, and separately identified live iMessage observations. Keep all ticket acceptance criteria unchecked until their required evidence exists. Record timestamps in UTC. Do not include credential values or raw private runtime data.
