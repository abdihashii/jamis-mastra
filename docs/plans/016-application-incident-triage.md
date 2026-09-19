# 016: Application incident triage

Status: **Planned.**

Linear: [JAM-65](https://linear.app/abdirahman-haji/issue/JAM-65/let-jamis-triage-a-specific-application-incident).

Give Jamis one bounded, read-only `triageIncident` tool that identifies, scopes, and classifies one Application incident from application-owned evidence. The tool may report a cause only when exact correlation proves it. It never retries, remediates, or exposes arbitrary trace, log, SQL, or shell access.

## Product boundary

- **Telemetry** is the recorded metrics, events, logs, traces, and durable outcome signals.
- **Monitoring** detects and reports known unhealthy conditions. Health, rate, and trend questions stay with Monitoring.
- **Observability** is the capability to correlate Telemetry and investigate why and how behavior occurred.
- **Incident triage** narrows and classifies an incident, its scope, its impact, its evidence gaps, and the next investigative path. Root-cause claims require conclusive evidence.
- JAM-65 stops at the Mastra application boundary. Full-Deployment Observability, Monitoring, and Incident triage remain JAM-67, JAM-68, and JAM-69.

## Decisions

- Reuse ClickHouse observability for execution evidence and existing Postgres records for durable outcomes. Do not add a general incident database.
- Keep one deep `triageIncident` module. It owns target resolution, evidence queries, classification, bounding, and sanitization. Callers do not know storage schemas or trace layouts.
- Correlate each authenticated Sendblue request with a one-way SHA-256 digest of its provider message handle. Export only the digest as one flat, indexed trace-metadata field; never export the raw handle.
- Record a content-free channel-boundary span with the same digest so authenticated intake and supported reply-delivery failures can be classified separately from the Jamis agent run.
- Resolve an immediate follow-up from a runtime-only channel capability and provider history. The model never receives or supplies a message handle, thread ID, or trace ID.
- Resolve application history from safe clues extracted from the operator's message: component, bounded UTC window, and an optional human domain reference such as `week 1`. Clues narrow candidates but do not establish identity by timestamp alone.
- Default an application-history lookup to the previous 24 hours and reject windows wider than 168 hours. An exact durable domain identity, such as configured league plus completed fantasy week, may resolve outside that window.
- Broad historical error questions search failed application incidents across components inside the supplied window. Queries about health, rates, or trends remain Monitoring requests.
- Query at most six candidates so the module can return either one exact result or `ambiguous` with at most five allowlisted candidates.
- Prefer lightweight trace lists and trace structure. Never return or inspect prompt, response, payload, raw log, recap text, personal-account content, or raw error bodies.
- Derive failure stages from span structure and known durable transitions. Map them to a small fixed vocabulary; unknown evidence remains `unknown` rather than triggering error-text interpretation.
- Keep `fantasy_recap_runs` authoritative for Fantasy outcomes. Store the latest attempt's exact trace reference and safe failure stage/classification on that existing row. Do not create an attempt-history table in JAM-65.
- APOSD and Ponytail constraint: no resolver registry, provider interface, factory, new dependency, speculative incident schema, or pass-through layer. Add a second implementation only when a real second implementation exists.

## Safe result contract

The public result contains only:

- `found`, `ambiguous`, `not_found`, or `unavailable`
- target kind, canonical component, UTC occurrence time, and optional human domain reference
- fixed failure stage and classification
- fixed scope and impact statements where application evidence proves them
- evidence gaps
- a trace reference only when correlation is exact
- at most five ambiguous candidates containing component, UTC time, stage, and human domain reference

No result field carries provider text, stored `last_error`, span input/output, message content, phone number, raw identifier, secret, or arbitrary metadata.

## Stage 1: Lock the language and evidence ownership

**Goal:** Commit the reviewed terminology, correlation boundary, and implementation plan before application code changes.

**Critical files:**

- `docs/CONTEXT.md`
- `docs/adrs/0013-channel-render-context-trace-boundary.md`
- `docs/adrs/0020-triage-incidents-from-owned-evidence.md`
- `docs/plans/016-application-incident-triage.md`

**Acceptance criteria:**

- Telemetry, Monitoring, Observability, Incident triage, Incident investigation, Application incident, Deployment, and Deployment incident have non-overlapping definitions.
- ADR 0020 records ClickHouse plus existing durable state as the evidence authorities and rejects both a general incident ledger and timestamp correlation.
- ADR 0013 permits only a derived safe channel correlation value and continues to exclude raw channel handles, payloads, render context, and credentials.
- The plan keeps health/trend work, root-cause investigation, remediation, and full-Deployment operations outside JAM-65.

**Verification:** `rtk git diff --check`, then inspect the documentation diff and the updated Linear issue links.

**Proposed commit:** `docs: define application incident triage`

## Stage 2: Correlate authenticated Sendblue requests

**Goal:** Give every authenticated operator message exact, content-free channel and Jamis trace correlation without adding storage.

**Critical files:**

- `src/mastra/channels/sendblue.ts`
- `src/mastra/channels/sendblue.test.ts`
- `src/mastra/index.ts`
- `src/mastra/observability.test.ts`

**Implementation boundary:**

- Derive the correlation digest only after the Sendblue adapter, direct-message check, and operator allowlist succeed.
- Put the digest in the message's fresh `RequestContext` before `defaultHandler` runs.
- Add that one flat key to the installed Mastra observability configuration's `requestContextKeys`.
- Add one content-free channel span carrying the same digest. It records fixed intake or reply-delivery classifications only where the channel boundary observes them.
- Keep the live thread and current message in a `WeakMap<RequestContext, capability>` for later exact preceding-message resolution. Do not serialize the capability or trust a lookalike request-context value.

**Acceptance criteria:**

- The same Sendblue handle always produces the same digest; different handles produce different digests.
- Concurrent or unrelated messages cannot share correlation.
- Exported metadata contains the digest but never the raw handle, operator number, text, raw payload, adapter config, or render context.
- Non-operator, group, non-Sendblue, malformed, and missing-context messages gain no triage capability.
- Supported channel failures emit only fixed stage/classification fields.

**Verification:** Run the Sendblue and observability tests first, then `rtk bun test`, `rtk bun run typecheck`, `rtk bun run lint`, and `rtk git diff --check`.

**Demo:** A test exporter receives two concurrent request traces with distinct digests, while a repository search of captured exports finds neither raw handle.

**Proposed commit:** `feat: correlate Sendblue requests with traces`

## Stage 3: Add the bounded application incident reader

**Goal:** Implement the deep read-only module that resolves trace-backed incidents and returns only the safe result contract, without exposing a Jamis tool yet.

**Critical files:**

- new `src/mastra/tools/triage-incident.ts`
- new `src/mastra/tools/__tests__/triage-incident.test.ts`
- `src/mastra/channels/sendblue.ts` only for the runtime capability lookup

**Implementation boundary:**

- Flush buffered observability events before querying, matching `checkMonitoring`.
- For a preceding request, fetch bounded Sendblue history through the trusted capability, select the preceding operator message, derive its digest, and query exact matching traces.
- For component or broad historical clues, query failed trace roots or branches inside one explicit UTC window. Use Mastra's installed `listTracesLight`, `listBranches`, and `getStructure` APIs.
- Group the channel span and Jamis trace by their shared exact digest. Multiple Jamis runs for one digest return `ambiguous`; they are never ordered into a guess.
- Map errored span types and known channel metadata to fixed stages such as `channel_intake`, `agent`, `model`, `tool`, `workflow`, `scheduled_job`, `application_storage`, and `reply_delivery`.
- Read structure only for selected traces. Ignore error objects, input previews, metadata outside the allowlist, inputs, and outputs.
- Query six candidates, return five, and make missing storage, failed flushes, query failures, missing capabilities, and incomplete evidence deterministic.

**Acceptance criteria:**

- Immediate follow-up resolves only the preceding authenticated operator request.
- Named-component clues cannot cross into another component.
- Broad historical clues search all failed application roots only inside the requested bound.
- Zero, one, two, and more-than-five candidates produce deterministic `not_found`, `found`, or bounded `ambiguous` results.
- Raw diagnostic content planted in every backend field never reaches the result.
- A cause remains absent unless a fixed correlated signal proves it.

**Verification:** Run the new focused test first, then `rtk bun test`, `rtk bun run typecheck`, `rtk bun run lint`, and `rtk git diff --check`.

**Demo:** Fixture traces for overlapping Jamis, subagent, tool, and workflow failures resolve by exact digest or safe clues, with no timestamp-only attribution.

**Proposed commit:** `feat: add bounded application incident reader`

## Stage 4: Correlate durable Fantasy recap incidents

**Goal:** Make the existing Fantasy recap run authority expose exact, safe triage evidence for failures before generation, during persistence, and during group delivery.

**Critical files:**

- `src/fantasy/runs.ts`
- `src/fantasy/coordinator.ts`
- `src/fantasy/daily.ts`
- `src/mastra/workflows/fantasy-weekly-recap.ts`
- `src/fantasy/__tests__/coordinator.test.ts`
- `src/fantasy/__tests__/daily.test.ts`
- `src/mastra/tools/triage-incident.ts`
- `src/mastra/tools/__tests__/triage-incident.test.ts`

**Implementation boundary:**

- Add idempotent columns for the latest attempt trace ID, safe failure stage, and safe failure classification to `fantasy_recap_runs`.
- Pass the current workflow trace ID from the installed Mastra workflow execution context into the recap coordinator.
- Claim the known completed week before loading its Fantasy facts so pre-generation failures land on the authoritative run.
- Replace the eager facts argument with one lazy facts loader inside the existing coordinator. Do not introduce a pipeline abstraction.
- Update guarded state transitions to write fixed safe classifications alongside existing private `last_error`; triage never reads `last_error`.
- Resolve a human reference such as `week 1` only against the configured league. The tool accepts no league ID or run ID.
- Validate a stored trace reference against the expected component before returning it. Missing or stale references become evidence gaps.

**Acceptance criteria:**

- Sleeper/fact building, recap generation, persistence, group-delivery rejection, delivery unknown, and interrupted attempts remain distinguishable without reading raw errors.
- Retry and concurrent-claim semantics from ADR 0018 remain unchanged.
- A requested completed fantasy week resolves directly even when outside the ordinary 168-hour trace window.
- The latest actionable non-sent Fantasy run can be surfaced as a candidate without implying JAM-66 monitoring exists.
- Schema initialization upgrades an existing table idempotently.

**Verification:** Run the coordinator, daily, and triage tests first, then the repository database checks that are available without production credentials. Run `rtk bun test`, `rtk bun run typecheck`, `rtk bun run lint`, and `rtk git diff --check`.

**Demo:** Forced facts, generation, persistence, and delivery failures each resolve to the exact configured league/week row and the correct fixed stage, including the no-Fantasy-Agent-span cases.

**Proposed commit:** `feat: correlate Fantasy recap incidents`

## Stage 5: Expose `triageIncident` through Jamis

**Goal:** Register the tool, route incident questions correctly, and prove both protocol boundaries live.

**Critical files:**

- `src/mastra/tools/triage-incident.ts`
- `src/mastra/tools/__tests__/triage-incident.test.ts`
- `src/mastra/agents/jamis.ts`

**Implementation boundary:**

- Expose only `preceding_request` or `application` target modes, an optional canonical component, one bounded UTC window, and one short human domain reference.
- Reject arbitrary IDs and windows wider than 168 hours. Relative civil dates use the configured operator time zone before becoming explicit UTC bounds.
- Route immediate “what happened?” follow-ups, component-specific historical failures, and bounded historical error questions to `triageIncident`.
- Keep health, error-rate, token, duration, and trend requests on Monitoring.
- Treat every result as untrusted evidence. Jamis reports a cause only when the result marks it proven.

**Acceptance criteria:**

- Direct tool execution is bounded, read-only, and sanitized.
- A forced iMessage failure is triaged by the immediately following operator message to the exact request.
- A named background component resolves only its own evidence.
- A broad bounded historical error question returns candidates; it does not become a health report or select the newest failure.
- Direct Studio or subagent attempts cannot use the preceding-request capability.
- Jamis does not delegate internal incident evidence to the research agent.

**Verification:** Smoke the tool through `mastra api` before invoking Jamis. Then run `rtk bun test`, `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run build`, and `rtk git diff --check`.

**Demo:** Perform one forced iMessage failure followed immediately by “What happened?”, then one forced Fantasy/background failure queried by component and human reference. Confirm every returned trace reference exists in Mastra Studio or `mastra api` and no unrelated run is attributed.

**Proposed commit:** `feat: let Jamis triage application incidents`

## Final gate

After all approved stage commits:

1. Run `review-code` for correctness and regressions.
2. Run `security-audit` for correlation, authorization, query, and diagnostic-data boundaries.
3. Run `ponytail:ponytail-review` for unnecessary abstractions and duplicated state.
4. Fix only verified findings, rerun the focused checks, then rerun `rtk bun test`, `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run build`, and `rtk git diff --check`.
5. Check every testable JAM-65 acceptance criterion and list the final commits. Pushing still requires separate approval.

## Research basis

- Installed `@mastra/core@1.61.0` documentation and types confirm per-message channel `RequestContext`, trace metadata extraction with `requestContextKeys`, exact metadata filters, lightweight trace structure, branch queries, and workflow/tool tracing context.
- [AWS monitoring versus observability](https://aws.amazon.com/compare/the-difference-between-monitoring-and-observability/) distinguishes known-health detection from why/how investigation.
- [AWS Incident Detection and Response](https://docs.aws.amazon.com/IDR/latest/userguide/observe-idr.html) states that monitoring reports something is wrong while observability establishes what is wrong and why.
- [PostHog Observability](https://posthog.com/handbook/growth/use-case-selling/observability) treats natural-language incident triage as narrowing error spikes, affected users, and relevant evidence.
- [Grafana Incident Management](https://grafana.com/products/cloud/incident/) places context gathering, severity, prioritization, and response coordination around triage.
- [Netflix Incident Management](https://netflixtechblog.com/empowering-netflix-engineers-with-incident-management-ebb967871de4) emphasizes simple incident declaration, shared language, consistent metadata, impacted areas, mitigation, and learning.
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) recommends interaction identifiers, hashing identifiers instead of logging raw values, excluding sensitive data, and treating event data as untrusted.

## Estimate

The current Linear estimate of 1 point is no longer credible. The plan has five independently verifiable stages across channel correlation, observability queries, durable Fantasy state, security boundaries, and live protocol smokes. Recommended estimate: **8 points**.

Implement one stage at a time. After each stage, show the diff summary and proposed commit, wait for explicit approval, then commit. Pushing requires separate approval.
