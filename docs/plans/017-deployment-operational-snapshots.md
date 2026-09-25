# 017: Deployment operational snapshots

Status: **JAM-66 through JAM-68 complete; JAM-69 gate pending.**

Linear: [JAM-66](https://linear.app/abdirahman-haji/issue/JAM-66/let-jamis-monitor-fantasy-weekly-recaps), [JAM-67](https://linear.app/abdirahman-haji/issue/JAM-67/make-the-full-jamis-deployment-observable), [JAM-68](https://linear.app/abdirahman-haji/issue/JAM-68/monitor-the-full-jamis-deployment), and [JAM-69](https://linear.app/abdirahman-haji/issue/JAM-69/triage-a-specific-jamis-deployment-incident).

Give the operator one natural-language operational surface through iMessage. Jamis routes broad state questions to `checkMonitoring` and one-incident questions to `triageIncident`. Both remain bounded and read-only. The operator, not Jamis, decides and performs any intervention.

## Delivery slicing

This roadmap contains four distinct concerns: Fantasy domain monitoring, Deployment evidence access, full-Deployment aggregation, and cross-component triage. They remain separate Linear deliverables. JAM-66 ships first. JAM-71 remains a separate Mastra upgrade immediately after JAM-66. JAM-67, JAM-68, and JAM-69 each require their own approved staged implementation plan before code changes.

The highest-risk later concern is the read-only host and container evidence boundary. The first JAM-67 implementation slice must prove that boundary in the deployed environment without exposing arbitrary shell access, raw Docker control, or sensitive output before any other component depends on it.

## Product contract

- **Operational snapshot:** an operator-requested account of service outcomes, component findings, recovered recent events, operating-normal evidence, and unknowns. It has no overall status and makes no intervention suggestion.
- **Observability:** continuously available evidence. Existing ClickHouse traces, logs, and metrics, Postgres durable outcomes, and source-native Deployment evidence remain federated.
- **Monitoring:** on-demand discovery. General snapshots are outcome-first, deterministic, exception-focused, and scoped by each evidence source's natural boundary.
- **Incident triage:** on-demand examination of one trusted target. It scopes and classifies; it does not discover broadly, investigate root cause, remediate, or act.
- **Current V1 boundary:** fixed Deployment inventory, categorical findings only, external-provider impact evidence only, safe read-only checks, allowlisted output, and no synthetic product transactions.
- **Deferred:** proactive alerts, polling, remediation, dynamic discovery, generic numeric thresholds, anomaly detection, provider-status checks, automatic investigation, a monitoring subagent, a new evidence database, and a generic reader framework.

## Evidence authority

1. Existing durable product state owns domain correctness.
2. Channel intake and delivery boundaries own message delivery evidence.
3. Top-level execution outcomes apply where no stronger product authority exists.
4. Child spans, logs, latency, traffic, saturation, token, and cost metrics are supporting evidence.
5. Missing or stale evidence makes only its component unknown.
6. Timestamp proximity may provide explicitly uncorrelated context but never identity or cause.

## Stage 1: Align language, decisions, tickets, and roadmap

**Goal:** Record the approved cross-ticket semantics without changing runtime behavior.

**Critical files:**

- `docs/CONTEXT.md`
- `docs/adrs/0020-triage-incidents-from-owned-evidence.md`
- `docs/adrs/0021-operational-snapshots-compose-owned-evidence.md`
- `docs/plans/015-jamis-monitoring-review.md`
- `docs/plans/016-application-incident-triage.md`
- `docs/plans/017-deployment-operational-snapshots.md`
- Linear JAM-66 through JAM-69

**Verification:** Run `rtk git diff --check`; inspect the complete documentation diff; re-read the four Linear tickets and confirm their statuses, priorities, and blocking relationships did not change.

**Demo:** The glossary, ADRs, roadmap, and all four tickets describe the same two-tool, outcome-first, owned-evidence model with no implementation claim.

**Proposed commit:** `docs: define Deployment operational snapshots`

## Stage 2: Add the Fantasy durable-outcome reader and Monitoring scope

**Goal:** Extend the existing `checkMonitoring` facade with one Fantasy scope while preserving the shipped application scope and adding no telemetry query, dependency, storage table, or generic reader abstraction.

**Critical files:**

- `src/fantasy/runs.ts`
- `src/mastra/tools/check-monitoring.ts`
- `src/mastra/tools/__tests__/check-monitoring.test.ts`

**Contract:**

- Accept the configured Fantasy scope with an optional exact week from 1 through 18. Jamis, not the tool, clarifies vague references such as “last week.”
- With no week, return configured-season counts plus the highest recorded Fantasy week. With a week, return that row or `null`; when no row exists, return `weekCompletion: complete | incomplete | unavailable` from the existing Sleeper completion semantics.
- Return `availability: available | unavailable` separately from the run. A run outcome is `sent`, `failed`, `delivery_unknown`, `active`, or `expired_active`.
- Count one current row per Fantasy week; attempts and retries do not inflate season counts.
- Derive active versus expired-active from one injected UTC instant and `lease_expires_at` without sweeping or mutating.
- Return only state-specific UTC timestamps, safe delivery source, safe failure stage, and safe failure classification. Null or legacy safe classifications become `unknown`.
- Read only the configured league. Never return the league ID, final recap text, raw error, group content, phone number, message handle, claim token, prompt, response, trace body, or arbitrary metadata.
- Preserve the existing application monitoring behavior until a later approved stage changes it.

**Verification:** Add focused tests for the provider-visible input schema, exact-week and season modes, deterministic highest-week selection, every run state, one injected clock, current-row counters, configured-league isolation, state-specific timestamps, unavailable storage/configuration, sanitization, and absence of mutation or observability queries. Then run `rtk bun test`, `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run build`, and `rtk git diff --check`.

**Demo:** Execute `check-monitoring` directly with the Fantasy scope and no week, then with one exact week. The result contains only the configured league's safe durable evidence and no Fantasy Agent metric.

**Proposed commit:** `feat: add Fantasy scope to monitoring`

**Implementation record (2026-09-21 UTC):** Commit `836d5cc` is pushed on `abdirahman/jam-66-let-jamis-monitor-fantasy-weekly-recaps`. The focused 12 tests and full 318 tests passed with typecheck, lint, build, and diff checks; three fresh correctness, contract, and Mastra reviews found no remaining issue. No deployment, direct-tool production smoke, iMessage smoke, or webhook change was performed. The direct-tool smoke remains the separately approved protocol boundary before Stage 3 routing smoke.

## Stage 3: Route Fantasy Monitoring through Jamis

**Goal:** Make natural-language Fantasy state questions use `checkMonitoring` without adding `checkFantasyMonitoring` or changing Fantasy group behavior.

**Critical files:**

- `src/fantasy/sleeper.ts`
- `src/mastra/agents/jamis.ts`
- `src/mastra/tools/check-monitoring.ts`
- `src/mastra/tools/__tests__/check-monitoring.test.ts`

**Contract:**

- Route “How is the Fantasy Companion doing?” to the general Fantasy scope.
- Route an exact “week 2” question to that week.
- Ask which fantasy week when the operator says “last week” or another ambiguous reference.
- For an exact week without a durable run, report whether the week is complete, incomplete, or unavailable. Use a bounded read-only Sleeper check, degrade provider failure or timeout to unavailable, and preserve caller cancellation.
- Report the source-native durable outcome, unknowns, and whether the evidence supports direct intervention. Do not invent an overall status or suggest an intervention command.
- Keep Fantasy group messages passive and keep internal evidence away from the research agent.

**Verification:** Run the focused monitoring tests, then `rtk bun test`, `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run build`, and `rtk git diff --check`. After commit, obtain separate approval for push, deployment, direct-tool production smoke, and iMessage smoke in that order.

**Demo:** Smoke the direct tool before Jamis. Then ask one general Fantasy question and one exact-week question through the operator's iMessage. Confirm the response matches the durable ledger, uses UTC timestamps, and includes no cross-league, raw, or observability data.

**Proposed commit:** `feat: route Fantasy monitoring through Jamis`

**Implementation record (2026-09-22 UTC):** [PR #30](https://github.com/abdihashii/jamis-mastra/pull/30) squash-merged to `main` as `786372d7b8dcb78963376a160e882fb8d7a0165d` and was deployed from `main`; production runs that exact SHA. The final focused 44 tests and full 322 tests passed with typecheck, lint, build, and diff checks. Fresh correctness, contract, Mastra, integration, security, and over-engineering reviews found no remaining issue after adding exact UTC reporting, deterministic cross-season completion semantics, a five-second Sleeper deadline, and exact parent-cancellation propagation.

All ten JAM-66 acceptance criteria were re-read and verified. Focused tests cover every durable run outcome, missing and empty data, unavailable configuration and storage, current-row counting, retry exclusion, ordering, one injected clock, configured-league isolation, sanitization, read-only SQL, absence of observability queries, and a failure before Fantasy Agent generation. Production direct-tool smoke preceded Jamis smoke: season mode returned one sent run with week 1 as the deterministic highest recorded week, and exact week 2 returned `run: null` with `weekCompletion: incomplete`. iMessage smoke returned the same general snapshot, explained that week 2 has no run because it is incomplete, and answered “Which exact fantasy week do you mean?” for “last week.” No Fantasy Agent metric, cross-league data, raw or excluded field, intervention command, Sendblue webhook change, or new monitoring surface was introduced.

## Later ticket gates

### JAM-67: Deployment Observability

Before implementation, write and approve a staged plan that inventories the fixed sources and proves the read-only host/container evidence seam first. Preserve authoritative storage, source-owned bounds and freshness, UTC timestamps, fixed component identities, explicit gaps, and safe correlation where it naturally exists. Do not centralize all evidence, expose arbitrary shell or Docker control, or infer cross-component causation from time.

**Acceptance demo:** From the deployed environment, the fixed reader set returns safe current evidence for host, Docker, app, Postgres, ClickHouse, Cloudflare Tunnel, and Tailscale; unavailable readers do not hide successful results; one application request and one scheduled run retain exact application correlation, while nearby host events remain explicitly uncorrelated.

### JAM-68: Full-Deployment Monitoring

Before implementation, write and approve a staged plan that composes JAM-66 and JAM-67 through the existing `checkMonitoring` facade. Lead with operator-conversation and Fantasy service outcomes, then component findings, recovered recent events, operating-normal evidence, and unknowns. Use safe read-only checks and source-relevant golden signals, but create V1 findings only from categorical rules.

Proposed staged plan: [020: Full-Deployment Monitoring](020-full-deployment-monitoring.md).

**Acceptance demo:** “What’s going on with the server?” returns a deterministic, partial-failure-safe snapshot of the fixed Deployment inventory with no overall status, raw evidence, synthetic product action, external provider poll, numeric threshold, or intervention suggestion.

### JAM-69: Full-Deployment Incident triage

Before implementation, write and approve a staged plan that extends the existing `triageIncident` facade with Deployment component readers. Accept only one trusted target from the preceding request, one unambiguous Monitoring finding, a named component, or an exact domain reference. Preserve `found`, `ambiguous`, `not_found`, and `unavailable`; show nearby evidence only as explicitly uncorrelated context; report a cause only when exact evidence already proves it.

**Acceptance demo:** A follow-up to one Monitoring finding resolves that component without selecting the newest system-wide incident, exposing raw evidence, guessing from timing, performing root-cause investigation, or changing the Deployment.

## Research basis

- [Google SRE: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) supports simple, low-noise monitoring; separates symptoms from causes; and keeps monitoring, basic triage, and deeper debugging distinct.
- [Netflix Telltale](https://netflixtechblog.com/telltale-netflix-application-monitoring-simplified-5c08bfa780ba) supports outcome-relevant signals, recovered-event context, and concise operator views instead of raw metric dumps.
- [Netflix CORE](https://netflixtechblog.com/keeping-customers-streaming-the-centralized-site-reliability-practice-at-netflix-205cc37aa9fb) separates impact scoping and incident coordination from deeper post-incident analysis.
- [Meta DrP](https://engineering.fb.com/2025/12/19/data-infrastructure/drp-metas-root-cause-analysis-platform-at-scale/) shows that automated investigation requires reviewed playbooks, secure execution, testing, and dedicated infrastructure, so it remains deferred here.
- Installed `@mastra/core@1.61.0` docs and source confirm that trace status comes from the root span, child errors are represented separately, workflow success means the workflow returned output, and duration metrics report span execution rather than product correctness.

## Approval discipline

For every implementation stage: implement, run focused and repository-wide gates, show the diff and proposed commit, and wait for explicit approval before committing. Commit approval is not push approval. Push, deployment, direct-tool production smoke, iMessage smoke, and any webhook change each require separate approval. JAM-66 requires no Sendblue webhook change.
