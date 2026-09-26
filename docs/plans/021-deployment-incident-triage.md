# 021: Deployment incident triage

Status: **Stages 1 through 3 implemented and locally verified. The named-component routing correction awaits commit sign-off and a production smoke.**

Linear: [JAM-69](https://linear.app/abdirahman-haji/issue/JAM-69/triage-a-specific-jamis-deployment-incident).

Extend the existing `triageIncident` facade to classify one selected Deployment incident from the sources established by JAM-67 and the findings produced by JAM-68. [ADR 0020](../adrs/0020-triage-incidents-from-owned-evidence.md) and [ADR 0021](../adrs/0021-operational-snapshots-compose-owned-evidence.md) already fix the evidence and product boundaries. No new glossary term or ADR is needed.

## Decisions

- Keep the existing authenticated preceding-request and exact configured-league Fantasy week paths. Add named fixed Deployment components and a follow-up to one finding from the immediately preceding Deployment Monitoring snapshot. An exact Fantasy Monitoring week already has a durable target; an application aggregate count does not identify one incident. Broad discovery remains `checkMonitoring` work.
- Retain only the latest allowlisted Deployment snapshot and its exact source references in app memory for the authenticated Sendblue direct-message thread. Bind it to the request that produced it. Resolve the next operator message, or its direct clarification reply, against that snapshot. Never trust a model-supplied trace, message, thread, container, or league identifier. After app restart or an unrelated message, ask for a fresh snapshot.
- One finding resolves without a selection prompt. Multiple plausible findings return bounded safe candidates so Jamis asks which one. A named component with multiple matching incidents also stays ambiguous; neither path chooses the newest incident.
- Reuse the existing `found`, `ambiguous`, `not_found`, and `unavailable` results. Extend only the fixed component, stage, classification, scope, impact, and evidence-gap values needed for Deployment evidence. Preserve the existing application result fields.
- Read each source within its real boundary: current host, Docker, app, Postgres, and Tailscale checks; the local five-minute Tunnel diagnostic; bounded ClickHouse history; configured-season or exact-week Fantasy state. Never turn a current check into historical evidence. A fixed Docker container name may identify that container exactly, but its state alone does not establish why its service failed.
- Keep `occurrenceTimeUtc` only when the owning source records an event time. A current-only observation carries `observedAtUtc` and an explicit unknown-occurrence gap. Do not present probe time as incident onset.
- Durable Fantasy outcome and authenticated channel boundaries outrank trace status. A Codex authentication reason may be reported only when its allowlisted event belongs to the exact selected trace. Host, container, and service observations never prove an application cause by temporal proximity.
- Every query and result is bounded and allowlisted. Optional nearby evidence is separately labeled `uncorrelated_context`; missing, stale, and failed readers retain their own gaps. No raw log, trace body, error, prompt, response, channel payload, personal content, credential, phone number, or arbitrary metadata reaches the model.

Concrete checks: a reply failure and a stopped Postgres container in one snapshot remain two targets even if their times match; “the reply one” selects only the channel evidence. A failed Fantasy week outside 168 hours still resolves from its configured-league row. A current Tunnel error has a UTC observation time, with its onset and external impact unknown.

## Execution model recommendations

| Stage | Model and effort | Reason |
| --- | --- | --- |
| 1 | GPT-5.6 Terra, High | Implement several source and time boundaries carefully. |
| 2 | GPT-6 Sol, Extra High | Handle authenticated thread binding, stale state, and forged selectors. |
| 3 | GPT-6 Luna, High | Follow the explicit routing contract and checks. |

If choosing only between GPT-6 Luna and GPT-5.6 Terra, use Terra High for Stage 1, Terra Extra High for Stage 2, and Luna High for Stage 3. These are execution suggestions, not delivery gates. See [Codex model guidance](https://developers.openai.com/codex/models) and [reasoning effort guidance](https://developers.openai.com/api/docs/guides/reasoning).

## Stage 1: Triage a named fixed component

**Goal:** Make one named Deployment component resolvable directly through `triageIncident`, with honest source scope and time semantics. This is the first code slice because it tests the federated reader and output boundary before conversational routing depends on it.

**Critical files:** `src/mastra/tools/triage-incident.ts`, `src/mastra/tools/deployment-evidence.ts` only if a small existing-reader change is needed, and focused tests under `src/mastra/tools/__tests__/`.

**Contract:** Accept only fixed component names and bounded windows where the source has history. Reuse the current safe evidence reader and existing application/Fantasy queries. A source-proven categorical failure is `found`; several incidents within the selected component are `ambiguous`; fresh normal evidence is `not_found`; absent, stale, or failed evidence is `unavailable`. Return exact references only after source validation. Do not add host commands, probe fields, storage, a new tool, or a reader framework.

**Verification:** Focused checks cover each fixed component, cross-component isolation, multiple candidates, fresh versus stale evidence, current observation versus event occurrence, exact Fantasy week outside trace windows, exact Codex reason, partial reader failure, and hostile raw fields. Run `rtk bun test`, `rtk python3 -m unittest discover -s infra -p 'test_*.py'`, `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run build`, and `rtk git diff --check`.

**Demo:** A direct `triage-incident` call naming a non-running fixed container returns only its proven state and UTC observation time. A call naming a different component cannot return that incident. An exact Fantasy week reads its configured-league row outside the ordinary trace window.

**Proposed commit:** `feat: triage fixed Deployment components`

**Stage 1 result (2026-09-26 UTC):** A direct `triageIncident` call selecting the fixed Postgres container returned its non-running state, UTC observation time, and source gaps from a sanitized evidence fixture. Component isolation, an exact Fantasy week outside the trace window, ambiguity, stale and unavailable evidence, Codex reason correlation, and hostile-field exclusion passed focused checks. The repository gate passed: 344 Bun tests, 4 Python tests, typecheck, lint, build, and `git diff --check`. The local host probe is not mounted, so a call against live local evidence reports `docker_probe_unavailable`; the authenticated production smoke remains in Stage 3.

## Stage 2: Bind a Monitoring follow-up to its finding

**Goal:** Make “what happened with that?” select a finding from the preceding trusted Deployment snapshot without re-discovering incidents or guessing from its timestamp.

**Critical files:** `src/mastra/tools/check-monitoring.ts`, `src/mastra/tools/deployment-monitoring.ts`, `src/mastra/tools/triage-incident.ts`, and their focused tests. Use the existing Sendblue runtime capability; change the channel handler only if its existing scope cannot prove the preceding operator message.

**Contract:** Capture the safe snapshot and any already-known exact source references only for an authenticated operator direct message. Make it eligible for follow-up only after Sendblue accepts the corresponding snapshot reply; if that reply fails, the next follow-up targets the preceding request. Keep one bounded in-memory entry for that thread. Verify the prior operator-message identity through the existing channel capability before resolving a follow-up. Match optional model-supplied safe finding clues against that captured entry; they are selectors, never authority. Preserve the entry through one clarification reply when multiple findings need selection. A missing entry, wrong thread, intervening message, or restart cannot select an incident. Keep the tool result allowlisted and never expose internal handles.

**Verification:** Focused checks cover one finding, multiple findings, clarification, accepted versus failed snapshot replies, unrelated/intervening messages, concurrent threads, forged selectors, process-state loss, same-time findings, source changes after the snapshot, safe exact references, and no leaked channel identifiers. Run the same repository gate as Stage 1.

**Demo:** A simulated authenticated snapshot followed by “what happened with that?” resolves its sole finding; two findings produce a clarification request. A forged or stale follow-up does not select the latest system-wide incident.

**Proposed commit:** `feat: bind triage to a Monitoring finding`

**Stage 2 result (2026-09-26 UTC):** An authenticated Sendblue message captured the safe Deployment snapshot; after its reply was accepted, a direct triage call selected the sole stopped Postgres container from that snapshot even after current evidence changed. Two same-time findings returned a clarification request, and the next accepted reply selected only the channel failure with its exact trace reference. Failed and generic-error replies targeted the preceding request; forged clues, intervening messages, other threads, and lost process state did not select a snapshot. The repository gate passed: 350 Bun tests, 4 Python tests, typecheck, lint, build, and `git diff --check`.

## Stage 3: Route Jamis and smoke both boundaries

**Goal:** Route one-incident iMessage follow-ups and named Deployment components to `triageIncident`, while broad questions continue to use Monitoring.

**Critical files:** `src/mastra/agents/jamis.ts` and focused routing tests. Touch the triage tool only for a verified provider-schema mismatch.

**Contract:** Jamis asks which finding when the trusted snapshot contains several. It reports target, component, supported UTC time, scope, impact, safe classification, evidence gaps, and exact safe references. It never reports a cause absent from the tool result, invents historical onset from a current probe, or suggests an intervention.

**Verification:** Check broad versus specific routing, immediate preceding request, one snapshot finding, multiple findings, named component, exact Fantasy week, unknowns, and sanitization. Run the full Stage 1 repository gate.

**Demo:** Call the tool directly through `mastra api` before Jamis. After separate push and deployment approvals, repeat an authenticated direct-tool production smoke, then ask Jamis over iMessage about one known Monitoring finding and one named component. Confirm the selected target matches source evidence and no unrelated incident is attributed.

**Proposed commit:** `feat: route Deployment incident triage through Jamis`

**Stage 3 result (2026-09-26 UTC):** Jamis routes broad Deployment questions to `checkMonitoring`, accepted-snapshot follow-ups to `triageIncident` with the `monitoring_finding` target, named components to the `application` target, and specific Fantasy recap incidents by exact week. Multiple possible findings prompt clarification; replies preserve unknown times, gaps, classifications, impact, and exact safe references without inferring cause or intervention. The focused routing checks passed: 17 tests. The initial full gate passed: 352 Bun tests, 4 Python tests, typecheck, lint, build, and `git diff --check`. Correctness, security, and Ponytail reviews found no issues. Linear has 9 of 10 acceptance criteria checked; nearby-evidence correlation remains open.

**Production smoke and correction (2026-09-26 UTC):** Commit `2a7e25a` was pushed and deployed; the app is running with zero restarts. The authenticated direct `triageIncident` call for Postgres returned HTTP 200 and a safe `not_found` result. Production Monitoring had zero `needsAttention` findings. An authenticated iMessage asking "Is Postgres running?" did not call `triageIncident`; the trace had no triage span, and Jamis incorrectly described Postgres as unsupported. The local correction now explicitly routes current-state questions for named Deployment components through `triageIncident` and explains that `not_found` does not prove a component is running. The exact local Jamis API smoke now calls the tool with `{ kind: 'application', component: 'postgres' }` and reports unknown state without claiming the component is unsupported. The full gate passed again: 352 Bun tests, 4 Python tests, typecheck, lint, build, and `git diff --check`. Commit and production redeployment of this correction await sign-off; the production iMessage smoke must then be repeated. Do not invent a Monitoring finding while none is present.

**Proposed correction commit:** `fix: route named Deployment status through triage`

## Delivery gate

For each stage, show the diff, focused result, full gate, and proposed commit; wait for explicit commit sign-off. Push and deployment need separate approval. After the last stage, run the full repository gate and focused correctness and security reviews, then check JAM-69 against its acceptance criteria and list final commits. No stage introduces broad discovery, a central incident store, root-cause investigation, remediation, alerts, a new dependency, or a generic reader framework.
