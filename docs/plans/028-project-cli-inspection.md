# 028: Project CLI inspection

Status: stage 1 authorized and started; namespace preflight blocked under local production-like Docker defaults. [JAM-86](https://linear.app/abdirahman-haji/issue/JAM-86/let-jamis-query-approved-project-files-with-bounded-rg-and-jq) created in the jamis team as Backlog, related to completed JAM-79. Stage 2 remains blocked. Decisions recorded 2026-10-03 UTC.

## Accepted scope

- Follow JAM-79's read-only Project understanding with useful `rg` and `jq` operations over its approved project view.
- Keep the existing prepared-view selection and credential/private-data exclusions. This ticket does not add authenticated service CLIs or general shell execution.
- Operator demo: "Count TypeScript files under src that contain Sendblue (case-insensitive), then list package scripts and Mastra dependencies." Verify the exact matching-file count and extracted metadata against the same prepared view.
- Expose bounded operation inputs, not arbitrary argv or shell text. The owning module constructs command arguments and fixes executable selection, project root, environment, and limits.
- Safety decisions must use deterministic validation and enforced isolation, never model judgment or prompt-based permission checks. Invalid or unsupported inputs are denied before execution. Query selection and natural-language answers remain model-generated; this decision does not promise deterministic model output.
- Preserve existing machine and JAM-79 restrictions. CLI processes access files directly rather than through LocalFilesystem containment, so they need an enforced boundary excluding the app's credentials, private runtime data, and evidence socket.
- Prove the required isolation in the current production execution environment before agent exposure. If the proof fails, keep CLI access unavailable and stop for replanning. Do not automatically add a separate execution service, relax privileges, or fall back to unisolated execution.
- Keep this ticket to `rg` and `jq` after reviewing developer and coding-agent workflows. Defer `ast-grep`, `yq`, and additional file-discovery tools.
- V1 operations: source text/regex searches scoped by relative paths and file globs; matching-file lists and counts; jq filter expressions over one approved JSON file per call. Additional JSON/module file access through imports/includes is unsupported. No shell pipelines, arbitrary argv, helper execution, multi-file JSON joins, generated artifacts, or project scripts.
- Commands may read the pinned approved view and the minimum runtime files needed for execution. They receive no app credentials, private data, evidence socket, or network access. Approved files remain read-only; any unavoidable execution scratch must be isolated and ephemeral, with no Operator-visible artifact feature.

## Verified constraints

- Installed `@mastra/core@1.71.0`: LocalSandbox defaults to isolation `none`. Its generated Linux policy runs commands through `sh -c`; structured argv is shell-quoted, not direct exec. Native Workspace command access is a broad shell interface.
- LocalFilesystem containment/read-only settings do not constrain command execution. Execution must enforce its own filesystem, environment, network, lifetime, and result guarantees.
- LocalSandbox includes PATH by default, supports per-command environment/cwd overrides, and retains unlimited command output unless `maxRetainedBytes` is set. Bounded retention keeps the newest bytes per stream and reports dropped bytes.
- Installed LocalSandbox's command timeout sends SIGTERM and waits for process closure; it does not force termination of a SIGTERM-resistant child. A review probe with a 50 ms timeout returned after about 1 second. Explicit process kill uses SIGKILL. The execution owner must enforce the deadline and complete cleanup independently of the native timeout option.
- Generated Bubblewrap policy can mount the workspace read-only and block network access, but also exposes standard binary/library paths and selected system files. Custom `bwrapArgs` replace that generated policy. Binary availability detection does not prove a real invocation works.
- The production app runs as non-root `bun` and has credentials, private runtime data, and an evidence socket. Its image currently installs neither `rg`, `jq`, nor Bubblewrap.
- Bubblewrap is a policy construction tool, not a complete security policy. Docker's default seccomp restricts namespace operations. Native isolation inside the production container is not verified. No privileged mode, Docker socket access, broad capability grant, or isolation-none fallback is assumed.
- Existing project-view preparation retains published generations through failed deployment attempts; cleanup occurs only after successful app recreation. Any execution lifetime decision must preserve this behavior.

Installed evidence: `src/mastra/project-workspace.ts`, `scripts/prepare-project-view.ts`, `infra/deploy.sh`, `Dockerfile`, `docker-compose.prod.yml`, and `node_modules/@mastra/core/dist/workspace-CfX5EIVK.js` plus sandbox type declarations.

Primary sources: [Bubblewrap security model](https://github.com/containers/bubblewrap#sandbox-security), [Docker seccomp policy](https://docs.docker.com/engine/security/seccomp/), [Mastra LocalSandbox](https://mastra.ai/reference/workspace/local-sandbox). [Bubblewrap Docker discussion #505](https://github.com/containers/bubblewrap/issues/505) corroborates compatibility problems; its proposed workarounds are not selected architecture or proof for this deployment.

## Design lens

Follow [Ousterhout's current-needs interface guidance](https://web.stanford.edu/~ouster/cgi-bin/aposd2ndEdExtract.pdf): one coherent execution boundary owns policy and result handling; callers should not reconstruct those guarantees. Reuse the existing project-view owner. Ponytail: no custom shell parser, speculative provider framework, extra agent, or duplicate file-reading tools.

## Developer and coding-agent tool research

Research checked 2026-10-03 UTC. Perplexity was rate-limited; Firecrawl Search used the same two discovery queries. A third Developer-index query checked structural-search command contracts. Selected first-party pages were read; artifacts remain ignored under `.firecrawl/`. These are qualitative capability comparisons, not measured token, performance, or answer-quality gains.

| Tool | Verified capability and project fit | Decision |
| --- | --- | --- |
| `rg` | Recursive text/regex searches with file filtering. Complements native grep with bounded file lists/counts. [Primary README](https://github.com/BurntSushi/ripgrep#ripgrep-rg). | Keep in this ticket. |
| `jq` | JSON field extraction, filtering, and aggregation using normal filter expressions. Useful for package metadata and approved JSON fixtures. [Primary manual](https://jqlang.org/manual/). | Keep in this ticket. |
| `ast-grep` | Structural code queries and JSON match output. Its first-party agent guide describes Claude Code search workflows; tooling also includes code outlines, rewrites, and rule scans. It is syntax-aware matching, not proof of runtime behavior or symbol resolution. [Agent guide](https://ast-grep.github.io/advanced/prompting), [tooling guide](https://ast-grep.github.io/guide/tooling-overview), [CLI contract](https://github.com/ast-grep/ast-grep.github.io/blob/47a2c45821c05e8d8ec820cbab03f46c54ce3aa5/website/reference/cli.md). | Strongest candidate for a later read-only code-structure ticket. Adding it now needs an explicit structural-query acceptance task and a new bounded operation contract. |
| `yq` (Mike Farah) | Structured YAML and other-format queries using jq-like syntax; not a complete jq substitute. Relevant to Compose and provisioning YAML. Supports mutation, environment reads, and loading other files, so defaults alone are not a safety boundary. [Primary docs](https://mikefarah.gitbook.io/yq). | Defer until structured configuration questions justify another query surface. |
| `fd` | Regex/glob filename discovery; also offers command execution. Filename discovery overlaps the existing native listing capability. [Primary README](https://github.com/sharkdp/fd#features). | Skip for this ticket. |

Accepted focus remains read-only queries over the existing approved project view. Do not copy interactive pipelines, rewrites, config-driven rule execution, or helper execution from developer examples into the agent interface.

## Result and execution contract

- Return complete bounded results or an explicit failure. Timeout, truncation, skipped/unreadable inputs, or resource-limit termination must not yield a successful query result or an authoritative count. A narrower query may be tried; do not automatically raise limits.
- Distinguish unsupported/denied input, missing file, unavailable capability, invalid regex/filter/JSON, and limit failure. `rg` exit 1 means a successful complete no-match result; exit 2 is an error. Do not apply that interpretation to jq. jq's normal output, including null/false or no selected values, is query data rather than a generic failure.
- Ticket defaults: executor-owned 10-second wall deadline; at most 64 KiB retained per stdout/stderr stream; one active CLI query per app instance, with concurrent requests receiving an explicit busy result. At the deadline, force termination of the entire command process group and await child cleanup before releasing the execution slot. Native SIGTERM-only timeout or returning from a Promise.race is not sufficient. Prove a hard per-command memory ceiling (initial target 256 MiB) without applying that ceiling to the app. These are implementation defaults, not additional Operator-selected product features. If limits cannot be enforced, the isolation stage is blocked.
- Bound pattern/filter input (initial default 4 KiB) and JSON input (initial default 4 MiB). Fix locale/time zone and stable ordering for file lists. Determinism guarantees apply to safety policy and file-list ordering, not every jq result: context-dependent builtins such as `now` may vary. This does not make regex text searches proof of symbol identity or runtime behavior, and model-selected queries/answers remain probabilistic.
- Input schemas expose only supported operations and query parameters. Reject unsupported keys, absolute/out-of-view paths, traversal, and escaping symlinks deterministically. Fix flags and sanitized environment; no rg config/preprocessor execution, jq caller-supplied module paths, command strings, caller-supplied stdin sources, cwd/env overrides, or background processes.
- For jq, enforce a narrower execution view containing only the validated, size-bounded selected JSON input plus the minimum runtime files. Do not mount the whole approved project view for jq or rely on fixed `-L`: expression-level import metadata can override its search path. Attempts to import/include another project JSON or module must fail without reading it, including through metadata search overrides. Prove this with a second approved JSON fixture both below and above the input limit and a project `.jq` module fixture. Use filesystem visibility to enforce this boundary; do not invent a jq parser.
- Pin the validated prepared generation already owned by Project understanding. Do not follow `current` mid-execution or introduce per-call view refresh/copies. Active queries must complete or terminate before their generation is retired. Retain the failed-deployment cleanup regression.
- Results identify the operation, relative scope, and view preparation time. Project queries do not establish runtime health or running-build identity. Keep CLI output untrusted; it cannot authorize another tool or account action.
- Telemetry should use bounded operation/status/duration/view metadata. Never copy app environment, credentials, private file contents, or evidence-socket data into query results or exported telemetry. Recheck existing tracing behavior during implementation rather than assuming a new tool bypasses it.

## Proposed implementation stages

The feature introduces CLI packages, execution isolation, a new tool contract, and a test surface. Separate the highest-risk proof from agent integration. Stage 1 was authorized on 2026-10-03 UTC. Each stage requires its own verification and explicit commit sign-off; pushing/deployment require separate authorization.

### 1. Prove bounded, isolated execution before agent exposure

**Goal:** execute real rg/jq queries over the existing approved view using deterministic policy and limits under production-like non-root Docker settings. Evaluate explicit Mastra native Bubblewrap first. Its exact policy, host kernel restrictions, effective mount visibility, and resource controls must be proven. A binary-presence check or a successful macOS run is insufficient.

**Critical files:** `Dockerfile`; proposed `src/mastra/project-cli.ts` and focused test; a synthetic Linux smoke under `scripts/`; `package.json` for the smoke command. Touch `docker-compose.prod.yml` only if required within existing privilege restrictions. Reuse `src/mastra/project-workspace.ts` and `scripts/prepare-project-view.ts`; do not duplicate view preparation. The agent's existing tool set remains unchanged in this stage.

**Verify:** proposed `bun run smoke:project-cli` builds/runs a disposable Linux fixture under the production identity and restrictions, with real CLI binaries. Demonstrate positive search/count/JSON queries; synthetic denied credential/env/socket and traversal/symlink probes; failed writes/network access; shell/flag injection rejection; no-match and invalid query behavior; time/output/memory failures; and missing-backend failure. Explicitly probe jq imports/includes and metadata search overrides against a second approved JSON file both below and above the input limit and a project module; verify they fail without reading those files. For the deadline, use a harness-owned SIGTERM-resistant child, prove forced process-group termination with no surviving children, and run a subsequent query to prove slot reuse. Harness-owned boundary probes must not become agent-accessible commands. Report assertions/categories, never fixture secrets. Preserve the existing view-refresh/failed-recreation regression. Run `bun run typecheck`, `bun test`, `bun run lint`, and `bun run build`.

**Demoable acceptance:** the Linux smoke prints passing positive/negative categories and bounded query results, with no agent CLI tools yet exposed. Actual production kernel compatibility remains a deployment gate, with a separately authorized synthetic smoke on the target host. If enforcement fails, record the blocker and stop; stage 2 stays blocked. No privilege expansion, custom permissive seccomp workaround, separate execution service, or isolation-none fallback is implicit.

**Proposed commit:** `feat: add isolated bounded project CLI queries`.

### 2. Expose project queries to Jamis and verify the Operator task

**Goal:** attach the bounded rg/jq capability directly to Jamis, preserving native JAM-79 file tools and existing evidence/account routes. One policy owner enforces validation, execution, lifecycle, and result guarantees. Do not expose Mastra's broad native shell/background tool alongside it.

**Critical files:** proposed `src/mastra/tools/project-query.ts`; `src/mastra/agents/jamis.ts`; relevant agent/tool tests; this plan and `docs/CONTEXT.md` only as needed to reflect final behavior. Reuse the stage 1 execution owner.

**Verify:** direct tool invocation for the exact demo before iMessage; ensure only bounded query inputs are exposed and native shell/background tools remain absent. Verify denied/unavailable/limit results and prompt-injection fixtures cannot bypass policy. Run the full typecheck/test/lint/build gate. After separately authorized deployment, repeat the synthetic isolation smoke under target settings and complete the iMessage demo against the same pinned view; verify existing Project understanding and Monitoring still work.

**Demoable acceptance:** the Operator receives the exact matching-file count plus package scripts and Mastra dependency metadata with repository-relative evidence references and preparation time. Narrow failure messages replace incomplete results, and missing CLI capability leaves ordinary project reads and unrelated requests usable.

**Proposed commit:** `feat: let Jamis query approved project files with rg and jq`.

## Documentation and remaining feasibility work

Stage 1 feasibility evidence (2026-10-03 UTC): an initial disposable `oven/bun:1.3.14-alpine` container installed real Bubblewrap/rg/jq, then ran Bubblewrap as UID 1000 under Docker's default seccomp/capabilities. It failed with `No permissions to create a new namespace`. Local Docker is OrbStack 29.4.0, Linux `7.0.14-orbstack-00380-ga7e0a2dc9535`, aarch64, with the builtin seccomp profile. This is local compatibility evidence, not evidence about the production host kernel.

`bun run smoke:project-cli` now reproduces the namespace gate using installed Mastra 1.71.0's explicit native Bubblewrap execution: its generated read-only policy for rg and a custom selected-input-only mount for jq. It builds a disposable fixture image from the production Bun base and pinned dependency manifests, prepares a synthetic view using the existing owner, and runs as `bun` with init, supplementary group 1000, a read-only project bind and unchanged Docker defaults. It removes its container, image and temporary fixtures. No actual credentials, private data, evidence socket, production containers or agent tools are involved.

Recorded smoke result: UID/binary checks passed (Bubblewrap 0.12.0, ripgrep 14.1.1, jq 1.8.2); both actual Mastra invocations exited 1 with the same namespace-permission denial. Typecheck, lint and build passed. Existing `bun run smoke:project` passed all three regressions, including the Linux read-only mount and failed-preparation/app-recreation behavior. The full test gate with local listener access reported 402 pass, 12 skip, 4 fail; the failures are three Fantasy broadcast database tests and Calendar tool wiring, all with PostgreSQL connection failures. No application source changed in this preflight.

The smoke is a **preflight**, deliberately exits nonzero even if namespace creation succeeds, and labels the remaining boundary/resource/lifecycle categories unproven. Stop at this gate if either invocation fails. The executor, production image packages, memory enforcement, deadline/process-group cleanup, jq import denial, and full negative probes remain unimplemented pending replanning or separately authorized target-host evidence. Production Docker/Compose and the agent tool set remain unchanged. Do not treat this partial stage as the proposed feature commit.

Project understanding remains the canonical capability; no new glossary term or ADR is needed for these reversible tooling choices. The glossary wording now includes inspection as well as explanation. No additional scope questions remain for ticket creation. Effective production isolation, memory enforcement, and deployment/active-query lifecycle are proof obligations of stage 1, not facts established by this planning session.

Review corrections recorded 2026-10-03 UTC: narrowed the determinism claim, required selected-input-only jq visibility with import/include probes, and required executor-owned forced termination plus slot-reuse proof. Read-only local probes verified the jq metadata-import bypass and Mastra's SIGTERM-only timeout behavior; they did not prove production isolation. [jq's date builtins](https://jqlang.org/manual/#dates) and [module system](https://jqlang.org/manual/#modules) define the relevant language behavior.
