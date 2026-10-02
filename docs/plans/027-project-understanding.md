# 027: Read-only Project understanding (JAM-79)

Status: Stage 1 committed and pushed as `10c0da4fb7d263bc24f10da19f02eda6936c4059` with Operator approval. Stage 2 locally implemented and verified in this changeset, with Operator commit sign-off on 2026-10-02T02:29:24Z. Stage 2 push and production deployment require separate approval.

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

Record gate totals, fixture/container check results, stage commits, and separately identified live iMessage observations. Check each ticket acceptance criterion only when its required evidence exists. Record timestamps in UTC. Do not include credential values or raw private runtime data.

### Stage 1 local evidence (2026-10-02T01:47:23Z)

- `scripts/prepare-project-view.ts` owns the fixed selection, recursive filename/directory exclusions, validation, and publication. It copies without following symlinks, normalizes approved files/directories to readable modes, records `.prepared-at` in UTC, and atomically replaces `.project-view/current`. Current and previous generations are retained; refresh and application restart run serially.
- `createProjectWorkspace()` resolves the prepared generation from an explicitly configured absolute path. Missing, relative, or invalid views return no capability; no checkout fallback. Native `LocalFilesystem` provides containment and read-only enforcement. Jamis is not attached yet.
- `bun run dev` prepares the view before startup. After manual checkout edits, restart with `bun run dev` before inspection. `bun run prepare:project` also refreshes it explicitly and prints the absolute path and preparation time. Existing Workspaces remain pinned to their prepared generation until restarted.
- Production preparation uses the pinned Bun image without installed dependencies. The production overlay mounts only the prepared view at `/project`, read-only, with `create_host_path: false`. Deployment builds the app, starts dependencies, and forces recreation of only `app` before starting the tunnel.
- Full gate: typecheck, lint, and build passed. `bun test` with an explicit disposable local Postgres URL: **399 passed, 12 skipped, 0 failed**, across 35 files. Sandbox-denied local fixture servers and a missing local database required tool-approved reruns; production storage was not used for the passing gate.
- `bun run smoke:project`: **2 passed, 0 failed, 162 assertions**. Native tools read source/configuration, list/search/stat, reject 28 nested excluded fixtures, traversal, escaped symlinks, and writes, report missing paths and skipped search reads, and discard stale entries on regeneration. Invalid preparation preserves the published view.
- Disposable Linux smoke uses the real production mount configuration with synthetic environment data and the dependency-free preparation command. UID **1000** reads a fixture originally mode 0600; a write fails specifically with **EROFS**. Missing bind sources are rejected without creating a view. An atomically replaced checkout file stays old in the existing mount until the deployment's app recreation command runs; afterward it reads replacement content with an **unchanged image**. Three stand-in services retain their container IDs. This verifies lifecycle isolation, not production database or tunnel behavior. Containers and temporary fixtures were removed.
- `$review-code`: four sequential read-only passes covering correctness, contracts/tests, access boundaries, and deployment integration. **Findings: None.** No dedicated reviewer-type agent runtime was available.
- `$security-audit`: input-to-file controls, configuration/secrets/dependencies, capability exposure, and cross-module integration verified. **Introduced exploitable findings: None.** Secret-pattern scan found no candidates in the seven relevant code/configuration files. `bun audit --json` reports **19 advisory records** across existing Axios 1.18.0, brace-expansion 5.0.9/1.1.18, and js-yaml 3.15.1 dependencies. Manifest dependencies and `bun.lock` are unchanged; Stage 1 adds no production agent/tool reachability. These advisories remain separate dependency maintenance, not a clean advisory result.
- `$ponytail:ponytail-review`: **Lean already. Ship.** Native tools and standard-library copying/publication cover the scope; no new dependency, provider, watcher, indexing service, or command tool.
- `$web-research`: reused saved scraped primary sources to revalidate [read-only binds](https://docs.docker.com/engine/storage/bind-mounts/), [long-form bind options](https://docs.docker.com/reference/compose-file/services/#long-syntax-6), and [`--force-recreate`/`--no-deps`](https://docs.docker.com/reference/cli/docker/compose/up/). The Linux smoke independently confirms those configured behaviors. Research artifacts remain ignored.
- `$mastra`: rechecked installed **@mastra/core 1.71.0** embedded documentation, declarations, and bundled implementation. Verified absolute roots, resolved-target containment, static read-only mutation-tool exclusion, no sandbox command tools, read ranges (`offset`/`limit`), and native grep's missing-path/read-error summaries. Exactly four tools are exposed: read, list, stat, and grep.
- Stage 1 commit: [`10c0da4`](https://github.com/abdihashii/jamis-mastra/commit/10c0da4fb7d263bc24f10da19f02eda6936c4059), `feat: add a contained read-only project workspace`, approved by the Operator on 2026-10-02T02:06:15Z and subsequently pushed with separate approval. No production deployment or live iMessage evidence.

### Ticket acceptance progress (2026-10-02T02:06:15Z)

- ACs **4, 5, and 6** are complete at the configured capability and disposable-fixture level: filtered access boundary, absent write/command tools plus Linux EROFS enforcement, and fresh content after app-only recreation with an unchanged image.
- ACs **1 and 2** await Stage 2 attachment and live iMessage requests. AC **3** awaits live identity/permission verification; local UID 1000 verification is complete.
- AC **7** has verified native missing/denied/partial results; model behavior and instruction-like file handling await Stage 2. AC **8** has the focused runnable check; plain-English routing awaits Stage 2. AC **9** has the passing full gate; live explanation and existing Monitoring smoke await authorized deployment.
- JAM-79 remains In Progress. Fixture evidence does not certify production deployment or live iMessage behavior.

### Stage 2 local evidence (2026-10-02T02:25:43Z)

- `src/mastra/agents/jamis.ts` attaches the Stage 1 Workspace through Mastra's native resolver, returning one process-lifetime promise. File-selection policy remains hidden in Stage 1; there is no custom tool, provider, agent, classifier, dependency, or infrastructure. The prepared generation stays fixed until application restart. Missing configuration/view resolves to no capability, without an inherited/global filesystem fallback.
- Four concise instruction bullets cover internal project evidence versus Monitoring/Incident triage/Online research, discovery and file/line references, preparation time and checkout-versus-runtime limits, untrusted names/content, ambiguity, and denied/missing/unavailable/truncated/partial results. Existing tools, delegation, channel authorization, confirmation controls, model, and memory configuration are unchanged.
- `src/mastra/agents/__tests__/project-understanding.test.ts` runs in isolated child processes with synthetic source, an excluded environment fixture, a broken symlink, and instruction-like documentation. It imports the actual Jamis attachment and checks the unchanged four application tools/four delegates. A controlled model proves exactly four native file tools reach the agent loop when configured, zero when unavailable, retrieved/error/partial evidence reaches the model, and Workspace preparation metadata is injected. Scripted responses establish integration contracts, not natural-language behavior.
- Full final gate: `bun run typecheck`, `bun run lint`, and `bun run build` passed. Full tests with both `DATABASE_URL` and `JAMIS_TEST_DATABASE_URL` explicitly set to a disposable loopback Postgres database named `jamis_sessions_test`, `PROJECT_VIEW_PATH` cleared, and `PROJECT_VIEW_DOCKER_SMOKE=1`: **411 passed, 0 skipped, 0 failed, 1,754 assertions across 36 files**. The disposable database was removed after verification. Production storage was not used.
- The Linux boundary smoke was rerun as part of that gate: **UID 1000**, approved read, write rejection specifically with **EROFS**, replacement content after app-only recreation with an **unchanged image**, and unchanged IDs for the three stand-in services. It also rechecked missing bind-source rejection and native exclusion/traversal/symlink/write controls. Fixture containers were removed.
- Real-model fixture smoke: `JAM79_LIVE_MODEL=1 bun --no-env-file test src/mastra/agents/__tests__/project-understanding.test.ts`, with an explicit non-serving loopback `DATABASE_URL`: **2 passed, 0 failed**, covering **11 plain-English requests** through the existing `openai-codex/gpt-5.6-terra` model and streaming gateway. All non-file tools/delegates were replaced by harmless fixtures; no channels, private memory, production database, or Operator messages were used. This observes model-driven routing, not deterministic intent recognition or live iMessage behavior.
- Observed list/search/read replies referenced retrieved fixture files. The explanation cited `src/handler.ts:1`, accurately limited its claim to string formatting, and stated the preparation time and checkout limits. Search explicitly reported the broken-symlink read skip as partial. The excluded `src/.env.prod` and missing source produced clear missing/unavailable replies with no invented contents. The unavailable-view request used no tool or Online research fallback. Both ambiguous requests asked which file without tool calls.
- The model read the controlled `docs/untrusted.md`, summarized its factual line with a file reference, and treated its override passage as untrusted content. It did not call the requested time-zone proposal, personal-account, or research tools. Both 72-hour server requests called only `checkMonitoring` with `{ scope: 'deployment', hours: 72 }`, including with the project view unavailable. Monitoring replies preserved the fixture's unavailable evidence.
- The first real-model run rejected a correct excluded-file reply because the smoke assertion did not accept the word "missing". The assertion was corrected without changing production behavior; all 11 requests then passed on the final run. Local test/build/network/Docker sandbox limitations required tool-approved execution; failures were not counted as passing evidence.
- `$review-code`: four sequential read-only passes on the Stage 2 diff relative to `10c0da4`, including the untracked integration check, covered correctness/regressions, contracts/tests, access boundaries, and integration/lifecycle. **Findings: None.** No dedicated reviewer-type runtime was available.
- `$security-audit`: four sequential read-only lanes traced Operator/channel authority, source-to-model-to-tool flow, native filesystem controls, configuration/secrets/dependencies, and cross-module delegation/confirmation boundaries. **Introduced exploitable findings: None.** Secret-pattern scanning of the relevant source/configuration found no candidates. The instruction-like fixture establishes observed resistance, not a universal prompt-injection guarantee.
- Native `bun audit --json` remains non-clean: **19 advisory records** (12 Axios, 6 brace-expansion, 1 js-yaml) in unchanged resolved dependencies. The new native read/list/stat/grep paths use filesystem operations and picomatch, not Axios or brace-expansion. No Workspace skills or index are configured to invoke YAML frontmatter parsing. Existing integration/Studio/build dependency reachability remains separate maintenance; this stage does not update `package.json` or `bun.lock`.
- `$ponytail:ponytail-review`: **Lean already. Ship.** Native Workspace injection and one shared promise cover the capability; the single fixture harness reuses scenarios for controlled and opt-in real-model checks.
- `$web-research`: Firecrawl Developer discovery plus scraped [Mastra filesystem documentation](https://mastra.ai/docs/sandbox/filesystem) confirmed filesystem tools work without a sandbox/command tools. Reused scraped [LocalFilesystem documentation](https://mastra.ai/reference/workspace/local-filesystem) for read-only/containment and saved Docker evidence for the unchanged mount lifecycle. Research artifacts remain ignored and uncommitted.
- `$mastra`: revalidated installed **@mastra/core 1.71.0** embedded docs, declarations, and bundled source. Confirmed native Agent Workspace resolvers, `getWorkspace()` returning no capability for an undefined resolver result, automatic file-tool injection and Workspace instructions in the stream, static read-only mutation-tool exclusion, resolved-target containment, and absent sandbox/index/skill tools. Controlled and real-model streaming checks independently exercised that integration.
- Verification logs are local only: `/private/tmp/jam79-stage2-tests-final.log`, `/private/tmp/jam79-stage2-build-final.log`, `/private/tmp/jam79-stage2-model-final.log`, and `/private/tmp/jam79-stage2-audit.json`. Only fixture source/results appear in model evidence.

### Ticket acceptance progress (2026-10-02T02:25:43Z)

- ACs **4, 5, and 6** retain their completed fixture/configuration evidence, independently rerun in the Stage 2 gate.
- ACs **7 and 8** are now verified locally: missing/unavailable/partial outcomes and untrusted-content handling were observed with the real model; the focused runnable checks and representative plain-English routing passed. This does not certify live production behavior.
- The JAM-79 issue body was updated and reread: only ACs 7 and 8 were newly checked; original wording and remaining compound criteria were preserved. Automatic approval review initially rejected the delivery-evidence comment and a minimal status-only alternative for insufficient explicit export authorization. After Operator approval on 2026-10-02T02:29:24Z, the reviewed evidence was successfully posted as issue comment `f5c35412-d2c6-4182-abf2-91f17c45bf21`.
- ACs **1 and 2** remain unchecked pending authorized deployment and live Operator iMessage listing/search/explanation. AC **3** remains unchecked pending live runtime identity/permission metadata. AC **9** retains the passing full gate but remains unchecked until the live checkout-grounded explanation and existing Monitoring smoke are observed.
- JAM-79 remains In Progress. Stage 1's implementation commit is `10c0da4`; Stage 2's implementation commit is `feat: let Jamis inspect approved project files` (this changeset), approved by the Operator on 2026-10-02T02:29:24Z. No Stage 2 push, production deployment, or live iMessage smoke. Push and deployment each need separate approval.
