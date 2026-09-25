# 020: Full-Deployment Monitoring

Status: **Stages 1 through 3 deployed and verified.**

Linear: [JAM-68](https://linear.app/abdirahman-haji/issue/JAM-68/monitor-the-full-jamis-deployment).

Extend `checkMonitoring` with an on-demand Deployment Operational snapshot. JAM-66 owns Fantasy recap outcomes; JAM-67 supplies fixed, read-only Deployment evidence. [ADR 0021](../adrs/0021-operational-snapshots-compose-owned-evidence.md) keeps Monitoring separate from [Incident triage](../adrs/0020-triage-incidents-from-owned-evidence.md). JAM-68 composes evidence and classifies known outcomes; it does not investigate causes or act.

## Decisions

- Keep the fixed component order: Host, Docker runtime, `app`, Postgres, ClickHouse, Cloudflare Tunnel, Tailscale private access. Assess all seven even when a reader is unavailable. Application traces and Fantasy durable state support the two service outcomes; they are not extra discovered components.
- Present five sections in this order: service outcomes, needs attention, operating normally, recent recovered events, unknowns. A component may have a narrowly proven operating fact and a separate gap. Never return a Deployment-wide status or score.
- A confirmed recent failed operation belongs in needs attention with its UTC occurrence time. It does not by itself prove a current outage. A recovered event requires source proof that the **same** operation or state subsequently succeeded. V1 adds no attempt-history store; the recovered section may be empty.
- Operator-conversation evidence distinguishes accepted intake, top-level execution, Sendblue reply acceptance, and unknown handset delivery. A verified in-flight iMessage request has accepted intake and a pending reply; completed historical counts exclude that request. No recorded historical requests is neutral, not a failure or proof of external reachability.
- Fantasy recap state in Postgres owns delivery correctness. Use the configured season and current rows, including `sent`, `failed`, `delivery_unknown`, `active`, and `expired_active`. A source-proven expected no-op is operating normally. Without source-owned proof that a week completed, an absent run is unknown as to whether a recap was due. Deployment scope makes no new Sleeper call.
- Accept optional `hours` from 1 through 168 for historical sources that support it, default 24. The host and runtime checks remain current, tunnel diagnostics remain five minutes, and Fantasy remains configured-season state. Show each source's actual UTC boundary, especially when the operator requests a longer window.
- Use only categorical source-owned rules for findings. Non-running fixed containers, a local tunnel error, failed Tailscale state, confirmed reply acceptance failure, and failed Fantasy outcomes can be findings. Numeric latency, traffic, load, memory, token, and resource values are supporting evidence without generic thresholds. A reader failure or stale result makes its own claim unknown while preserving independent evidence.
- Allow only fixed classifications, UTC timestamps, bounded counts and measurements, explicit gaps, and safe exact references past the tool boundary. Never expose raw diagnostic content, message text, phone numbers, provider responses, arbitrary metadata, or inferred cross-component causes. External reachability and handset delivery remain explicit limits of local evidence.
- Add no synthetic message or provider transaction, provider-status poll, arbitrary shell, intervention command, suggested next check, alert, polling loop, new dependency, or evidence database. JAM-69 owns one-incident triage.
- Correct the older application-only `checkMonitoring` result so a warning log cannot produce a product-health verdict. Retain its bounded metrics and redacted logs as supporting evidence, and report availability and recorded activity without `healthy` or `degraded` rollups. Keep the Fantasy exact-week contract unchanged.

## Stage 1: Add the direct Deployment snapshot

**Goal:** Compose source-owned service outcomes and all seven fixed components behind `checkMonitoring` before changing Jamis routing.

**Critical files:** `src/mastra/tools/check-monitoring.ts`, `src/mastra/tools/deployment-evidence.ts`, and focused tests under `src/mastra/tools/__tests__/`.

**Contract:** Add `scope: 'deployment'`; reject `week` for this scope and allow its bounded `hours`. Reuse the JAM-67 reader and JAM-66 Fantasy reader. Read bounded Sendblue channel and top-level application outcomes from ClickHouse using exact existing identities. Inspect an existing workflow no-op only if its stored result can be selected and strictly allowlisted. Preserve partial results and source-owned scopes. Never classify a child error or warning count as product failure. Build the five ordered sections in the tool result so their order does not depend on model prose.

**Verification:** Focused fixtures cover each service outcome, current in-flight intake, no historical activity, a confirmed recent failure, proven versus unproven recovery, source-proven no-op, missing expected execution, all seven component states, mixed success and reader failure, source-specific time bounds, deterministic order, strict sanitization, and no provider or mutation call. Run `rtk bun test`, `rtk python3 -m unittest discover -s infra -p 'test_*.py'`, `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run build`, and `rtk git diff --check`.

**Demo:** Execute `check-monitoring` directly with `{"scope":"deployment"}` and `{"scope":"deployment","hours":72}` against a running local server. Observe both outcomes first, seven fixed component assessments, explicit mixed time bounds and gaps, and no raw fields. The local host probe may correctly report unavailable. After separate push and deployment approvals, repeat the authenticated direct-tool smoke in production before any Jamis routing smoke.

**Proposed commit:** `feat: compose Deployment monitoring snapshot`

### Stage 1 result (2026-09-24 UTC)

- `checkMonitoring` accepts `scope: 'deployment'`, optional 1 to 168 `hours`, and no `week`. Its application and Fantasy scopes retain their existing behavior.
- The tool returns the five ordered sections, followed by a fixed-order assessment of Host, Docker runtime, `app`, Postgres, ClickHouse, Cloudflare Tunnel, and Tailscale. All model-facing values are categorical allowlists, UTC times, bounded counts, safe week/container references, and evidence gaps. There is no Deployment-wide verdict or recovery claim without source proof.
- Operator evidence separates the current request's accepted intake and pending reply from completed historical reply acceptance, intake failure, and top-level Jamis execution. Sendblue reply acceptance leaves handset delivery unverified. Fantasy uses configured-season current rows; stored workflow `snapshot.result.output.outcome` supplies a verified no-op or a categorical pre-row execution error. An absent run does not establish that a recap was due.
- History uses the requested 24-hour default or bounded `hours`; the local tunnel diagnostic boundary remains five minutes, and current host/runtime checks and configured-season Fantasy state keep their own boundaries. Failed or timed-out readers leave the other results visible.
- Local direct-tool smoke against Postgres and ClickHouse returned HTTP 200 for `{"scope":"deployment"}` and `{"scope":"deployment","hours":72}`. Both led with the two service outcomes and assessed all seven components in fixed order. The local host, Docker, tunnel, and Tailscale probes were unavailable, while the current app, Postgres, and ClickHouse checks were available. Fantasy was unconfigured locally. The output contained no raw diagnostic fields. The local server used an explicit `OPERATOR_TIMEZONE=America/Chicago` setting for the smoke; no configuration file changed.
- Gate: 336 Bun tests and 4 infra Python tests passed; typecheck, lint, build, and `git diff --check` passed. The direct-tool smoke preceded any Jamis routing work.
- Reviews: `$review-code` verified the stored workflow result shape, failure occurrence times, child-span exclusion, and request count semantics; the findings were fixed and rechecked. `$security-audit` found no exploitable Stage 1 path or secret leak. Read-only `bun audit` reports a preexisting high `js-yaml@3.15.1` advisory via Mastra's `gray-matter`; this diff changes no dependency and exposes no YAML parsing path. `$ponytail:ponytail-review` found no further Stage 1 complexity to remove without losing source boundaries or the output allowlist.

**Linear AC check:** Criteria 2 through 8 are checked in JAM-68. The direct tool proves fixed seven-component coverage and order, service outcomes first, distinct failures/no-ops/no activity/unknowns, partial-reader isolation, source-authority precedence, and the absence of a rollup, raw content, synthetic transaction, provider poll, generic numeric threshold, or intervention suggestion. The recovered section is empty because current sources do not prove a same-operation recovery. Criteria 1 and 9 remain open for Stage 3 routing and manual iMessage smoke. An authenticated production direct-tool smoke remains after separate push and deployment approvals, before the Stage 3 iMessage smoke.

## Stage 2: Remove the misleading application-only verdict

**Goal:** Make an application-only review compatible with the source-authority rule without changing its bounded metrics, log redaction, or Fantasy exact-week behavior.

**Critical files:** `src/mastra/tools/check-monitoring.ts`, `src/mastra/tools/__tests__/check-monitoring.test.ts`, and the application-only instruction in `src/mastra/agents/jamis.ts`.

**Verification:** Show that a warning or failed child span alone cannot yield a product-health claim; a failed top-level execution remains reported as an execution outcome, and absent or partial queries preserve successful evidence and their gaps. Run the same repository gate as Stage 1.

**Demo:** A direct application-scope call with a warning fixture reports the warning as supporting evidence without `degraded`; a failed top-level run remains visible with its UTC window. Jamis describes only what that evidence proves.

**Proposed commit:** `fix: remove application monitoring health verdict`

### Stage 2 result (2026-09-24 UTC)

- Application-only `checkMonitoring` now returns evidence `availability` (`available`, `partial`, or `unavailable`) and `recordedActivity` (`present`, `none`, or `unknown`) instead of a `healthy`, `degraded`, or `empty` verdict. `failedRuns` remains a top-level execution count within the exact UTC window. Warning and child-error logs remain redacted supporting evidence and never change those fields into product-health claims.
- The seven bounded Jamis metric queries and 20-log cap are unchanged. A failed query names its specific gap in `unavailableQueries`, leaves its value unknown, and preserves successful counts, measurements, and logs. Missing storage leaves activity unknown. The Fantasy exact-week reader and Deployment snapshot are unchanged. Jamis's application-only instruction now reports the evidence and its limits.
- Direct application-scope tool fixtures show a warning plus child error without a health verdict and a failed top-level execution with `failedRuns: 1`; the reader fixture verifies the latter's UTC window. Focused tests also cover no recorded runs, missing storage, a failed log query, and a failed execution-count query.
- Gate: 336 Bun tests and 4 infra Python tests passed; typecheck, lint, build, and `git diff --check` passed. The Bun suite needed local Postgres and ClickHouse; both were stopped again afterward.
- Reviews: `$review-code` found no verified correctness or contract issue after checking callers, partial results, and scope compatibility. `$security-audit` found no new exploitable path or leaked diagnostic data. Read-only `bun audit` still reports the preexisting high `js-yaml@3.15.1` advisory through Mastra's `gray-matter`; Stage 2 changes no dependency or YAML parsing path. `$ponytail:ponytail-review`: lean already, with no behavior-preserving cut identified.
- Commit `b37e1c0` was pushed and deployed on 2026-09-24 UTC. Production's authenticated application-scope direct-tool call returned HTTP 200, `availability: available`, `recordedActivity: none`, zero completed and failed runs in its exact 24-hour UTC window, no query gaps, and no `status` field. No logs were present; the redaction contract remains covered by the focused fixture.
- Authenticated production Deployment direct-tool calls returned HTTP 200 for the default 24 hours and explicit 72 hours. Both led with the operator-conversation and Fantasy outcomes, assessed all seven fixed components in order, kept a five-minute tunnel window, and returned only allowlisted facts and gaps. The 72-hour window reported one historical `top_level_execution_failed` at `2026-09-22T16:20:03.363Z`, without claiming a current outage. Fantasy season counts were two sent and zero failed, unknown, active, or expired runs. These calls ran from inside the production app container against its loopback API with the configured bearer token; external reachability remains unverified by this smoke.

**Linear AC check:** JAM-68 criteria 2 through 8 remain checked. Stage 2 specifically rechecked source authority (criterion 6): warning and child error logs cannot become product failures, while a failed top-level execution remains an execution outcome. The application output still has no overall rollup or raw log message (criterion 7), and partial readers preserve successful evidence (criterion 5). The authenticated production direct-tool smoke is complete (criterion 8). Criteria 1 and 9 remain open for Stage 3 routing and iMessage smoke.

## Stage 3: Route broad Deployment questions through Jamis

**Goal:** Route “What’s going on with the server?” and other broad Deployment questions to the new scope, while keeping specific Fantasy and application requests on their existing scopes.

**Critical files:** `src/mastra/agents/jamis.ts` and focused routing tests.

**Verification:** Exercise broad and time-qualified Deployment questions, application-specific questions, exact and ambiguous Fantasy weeks, output section order, UTC boundary language, partial evidence, and no intervention suggestion. Run the Stage 1 repository gate again across the completed change.

**Demo:** After the authenticated production direct-tool smoke, the Operator asks Jamis one broad Deployment question over iMessage. The reply leads with operator conversation and Fantasy outcomes, then findings, narrow positive evidence, proven recoveries, and unknowns. It does not claim handset delivery, infer a cause, disclose raw topology beyond the fixed allowlist, or suggest an action.

**Proposed commit:** `feat: route Deployment monitoring through Jamis`

### Stage 3 local result (2026-09-24 UTC)

- Jamis now sends broad server and full-Deployment questions to `checkMonitoring` with `scope: 'deployment'`, using the default 24-hour history or a requested whole-hour window from 1 through 168. Specific application questions and general, exact-week, or ambiguous-week Fantasy questions retain their existing routes.
- The Deployment reply instruction follows the tool's five-section order, gives the exact UTC history and tunnel windows, preserves narrow facts beside source gaps, and does not infer current outage, recovery, cause, handset delivery, or an intervention. The fixed component allowlist remains the only topology Jamis may name.
- Focused routing assertions cover broad and 72-hour examples, scope precedence, the bounded window, section order, UTC boundaries, partial evidence, and reply limits. Existing Fantasy routing and Deployment output fixtures cover exact and ambiguous Fantasy weeks, the seven components, and source-owned evidence. These were prompt and direct-tool checks before the manual iMessage smoke below.
- Gate: 337 Bun tests and 4 infra Python tests passed; typecheck, lint, build, and `git diff --check` passed. The Bun suite used local Postgres and ClickHouse, which were stopped afterward.
- Reviews: `$review-code` found the unsupported subhour window and it was fixed; `$security-audit` found no new exploitable path or leaked diagnostics; `$ponytail:ponytail-review` trimmed duplicate prompt assertions. Read-only `bun audit` still reports the preexisting high `js-yaml@3.15.1` advisory through Mastra's `gray-matter`. This stage changes no dependency or YAML parsing path.
- Commit `9041c08` was pushed and deployed on 2026-09-24 UTC. The production checkout resolved to that SHA, Compose showed all four services running after replacing `app`, and an authenticated in-container `/api/agents` request returned HTTP 200.

### Stage 3 production iMessage smoke (2026-09-24 UTC)

- The Operator sent “What's going on with the server?” over iMessage and received Jamis's reply. A lightweight production trace recorded a successful Jamis run starting at `2026-09-24T17:54:44.375Z` and a `checkMonitoring` tool call at `2026-09-24T17:54:50.487Z`. No message or tool payload was read from the trace.
- The reply showed the Deployment history window `2026-09-23T17:54:50.495Z` to `2026-09-24T17:54:50.495Z` and the five-minute tunnel window `2026-09-24T17:49:50.495Z` to `2026-09-24T17:54:50.495Z`. Operator conversation and Fantasy recap outcomes led the five sections; all seven fixed components were assessed. Needs attention and proven recoveries were empty, while separate unknowns preserved external reachability and source gaps.
- The snapshot described the current intake as accepted with reply pending at observation time, and handset delivery as unverified. It made no current-outage, inferred-cause, raw-diagnostic, extra-topology, or intervention claim.

**Linear AC check:** Criteria 1 through 9 are satisfied. The manual iMessage reply and tool-call trace verify the broad Deployment route and the concise fixed-inventory snapshot. The authenticated production direct-tool smoke preceded this Jamis smoke.

### Post-merge production iMessage smoke (2026-09-25 UTC)

- After squash merge `21330a7` was deployed from `main`, the Operator repeated “What's going on with the server?” over iMessage and received a Deployment snapshot. Lightweight trace metadata recorded a successful Jamis run at `2026-09-25T01:40:43.089Z` and a `checkMonitoring` call at `2026-09-25T01:40:48.801Z`; no message or tool payload was read from the trace.
- The reply led with operator conversation and Fantasy recap outcomes, then needs attention, operating normally, recent recovered events, and unknowns. It assessed all seven fixed components, showed a 24-hour UTC history window and a separate five-minute tunnel window, and made no unsupported delivery, outage, cause, extra-topology, or intervention claim.

## Research basis

- [Google SRE, Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) defines monitoring broadly, distinguishes symptoms from causes, and names latency, traffic, errors, and saturation as the four golden signals. Its guidance favors simple, comprehensible rules and warns against inferred causality.
- [Google SRE Workbook, Monitoring](https://sre.google/workbook/monitoring/) includes metrics, logs, structured events, and traces as monitoring evidence, with freshness and presentation chosen for the use case.
- [Google SRE Workbook, On-Call](https://sre.google/workbook/on-call/) describes triage as assessing incident impact and severity before deeper diagnosis or remediation. JAM-68's broad snapshot stops before that incident-specific work.

## Approval discipline

Approve this staged plan before runtime changes, as required by [the roadmap](017-deployment-operational-snapshots.md). Complete and verify one stage at a time. Show each stage's diff and proposed commit, then wait for explicit commit sign-off. Push and deployment each require separate approval. Smoke the direct tool before Jamis routing and the iMessage response. Do not commit this plan or a stage without sign-off.
