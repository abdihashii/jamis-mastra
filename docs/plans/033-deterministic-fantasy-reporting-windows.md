# 033: Deterministic Fantasy reporting windows

**Status:** Steps 1–2 committed (`2fd4867`, `517a31a`) and Operator-confirmed deployed. Corrected editorial-only preview and one explicitly authorized saved Week 6 group publication passed, including Operator-observed receipt. The production recap cron remains Operator-paused.

## Goal and constraints

Replace collection-time archive bounds with queried NFL calendar periods. One frozen UTC interval governs chat, news and transaction admission; scores and lineups remain tied to their requested Sleeper season/week. Querying is deterministic application code, never an agent or agent-facing tool.

This corrects [plan 032](032-fantasy-pundit-editorial-workflow.md)'s reporting-window behavior. The source-pinned editorial-v2 Week 6 mock run passed transport/control-flow checks, but the Operator rejected its moving cutoff. Neither retained Week 6 artifact is publication authority. Preserve both without edits or regeneration.

ESPN's calendar is a provider-defined period, not a final-whistle timestamp. Tuesday may legitimately belong to the preceding period. No manually chosen closing hour, `now` fallback, silent calendar extension, automatic provider failover or invented actual-finish time is permitted.

## 1. Prove and implement the off-path calendar reader

**Goal:** validate the source contract before production depends on it.

**Critical files:** `src/lib/fantasy/nfl-calendar.ts`, its tests and public-response fixtures. Do not change `daily.ts`, existing window selection, evidence admission, saved-report schemas or delivery.

- Query the requested and adjacent ESPN calendar periods plus the requested week's ESPN scoreboard through fixed public HTTPS routes, bounded deadlines and no retries/redirects. No credentials or new dependency.
- Validate source identity, season, phase, week, ordered dates and calendar adjacency. Preserve the provider's minute-resolution end explicitly; use the queried next start as the exclusive cutoff, never a guessed extra interval.
- Cross-check exact scoreboard kickoff timestamps and final states against the calendar and Sleeper's requested-week game membership/completion. Missing, malformed, incomplete, conflicting or future data returns a safe blocked result.
- Preserve real delayed-game behavior: 2020 regular week 12 was extended through 2020-12-03T07:59Z and week 13 starts 08:00Z; the postponed BAL–PIT kickoff was 2020-12-02T20:40Z.
- Verify regular-season/postseason transitions and keep ESPN's Pro Bowl numbering distinct from Sleeper's postseason game weeks. An unavailable next period blocks, including the final Super Bowl period; no current-time or next-season fallback.
- Retain minimal attributable calendar/game proof with the returned bounds. This remains off the active path.

**Verification:** offline native HTTP fixtures for current Week 6/7, delayed Wednesday game, regular/postseason transition, scope/identity/status/count conflicts, boundary precision, malformed dates, missing next period, cancellation/deadline/body consumption, redirects and no retry. Then full repository typecheck/test/lint/build/infra/diff gates and fresh independent reviews.

**Demo:** `rtk bun test src/lib/fantasy/__tests__/nfl-calendar.test.ts`, showing Week 6's queried `[2026-10-14T07:00Z, 2026-10-21T07:00Z)` unchanged at later collection times, and contradictory or unverified periods blocked.

**Verification result (2026-10-21 UTC):** 41 focused cases passed. The full repository gate passed: 1,463 tests, one Linux-only skip, zero failures (1,464 tests across 79 files, 12,814 assertions); full typecheck; lint with zero errors/320 line-length warnings; four infra tests; standard Mastra/Studio production Docker build; whitespace checks. Four fresh read-only correctness/contracts/security/Ponytail reviews and two post-fix verification passes found no remaining issues.

The actual reader was also exercised against anonymous public endpoints on both macOS and Linux/Bun 1.3.14. Each run received four HTTP 200 responses (Sleeper schedule plus three ESPN reads), matched 14 Week 6 games and returned `[2026-10-14T07:00:00.000Z, 2026-10-21T07:00:00.000Z)`. No application model, paid NFL research, database or message send was involved. The first native probe exposed rejection of Bun's default client header; a repro-first regression and an explicit honest project User-Agent fixed it, without credentials, retries or browser impersonation.

These checks verify a local off-path reader and observed public contracts, not VPS/application deployment, historical provider revision timing, actual final-whistle timestamps or source-admission cutover. Existing production composition, schemas, report bytes and model/transport settings remain unchanged. The prior plan-032 sample's technical acceptance record is carried as documentation, explicitly noting that its coverage was rejected.

**Commit:** `2fd4867` (`feat: validate queried NFL reporting calendar boundaries`), with commit-only approval. The Operator subsequently held deployment for Step 2.

Step 1 commit approval does not authorize an assistant push or deployment. Step 2 remains a separate implementation/review/commit boundary.

## 2. Wire the shared window and evidence admission

**Goal:** remove the moving reporting cutoff from new generation without rewriting existing artifacts or attempts.

**Critical files:** `daily.ts`, `chat-window.ts`, `pipeline.ts`, `recap-evidence.ts`, `chat-archive.ts`, `nfl-sources.ts`, generation capture/state compatibility as required, previews/CLI and their tests; maintained Fantasy docs.

- Use the verified calendar reader in the shared new-report entrypoint. Persist its immutable bounds and attributable proof with the attempt/evidence; never let a model choose or override them.
- Admit chat by original sent time. Admit news by publication/version time, withholding later or unverifiable content rather than reconstructing an unavailable historical version. Keep week-scoped result/injury evidence distinct from recent-news timestamps and retrieval time.
- Admit transaction claims only when source timestamps establish eligibility under the shared bounds. A later `status_updated` is not proof of the exact completion instant; ambiguous timing is a gap, not invented chronology.
- Preserve essential-source fail-closed handling, optional-source gaps, historical parsing, exact saved-report retries and existing exhausted-attempt holds. Do not silently re-enter an old blocked attempt with a different window.
- No model, effort, budget, transport or publication-authority changes. No schedule POST, cron resumption or real send.

**Verification:** reproduce the moving-cutoff and post-cutoff evidence bugs first; assert inclusive start/exclusive end across sources, stable later previews, late-updated news exclusion, transaction-time uncertainty, game/calendar conflicts, phase transitions and unchanged historical retries. Run the full repository gate and fresh reviews.

**Demo:** a separately authorized source-pinned Week 6 no-send run, preserving both existing private artifacts and retaining any new approved sample at a distinct private path. Show queried bounds, admitted source counts, exact approved parts and zero real sends. A failed application deployment is not repaired or certified merely by mounted-source execution.

**Implementation:** `chat-window.ts` now loads the requested Sleeper phase and queried calendar, with no moving-date fallback. The pipeline resolves it only for new work, stores optional non-defaulted proof on the existing attempt and frozen packet, and requires that proof before paid reservations/new approval. Historical proofless state remains readable without backfill or CAS changes, but proofless held restarts are denied before any calendar/paid work. Verified restarts retain original proof/bounds; changed coverage blocks. News/transaction admission precedes editorial catalog construction. The read-only CLI accepts `preview-candidate --week 6 [--nfl]` with no manual dates; paired dates only assert the query. It invokes the writer/editor, not Broadcaster.

**Verification result (2026-10-21 UTC):** full suite 1,476 passed, one Linux-only skip, zero failures (1,477 tests across 79 files; 13,998 assertions). Full typecheck, lint (zero errors, 334 line-length warnings), standard production Mastra/Studio Docker build, four infra tests and whitespace checks passed. Native disposable PostgreSQL and scripted model fixtures exercised persistence, exact saved retries, read-only previews, source filtering and restart holds. Four fresh read-only correctness/contracts/security/Ponytail reviews found one concrete integration defect: equivalent games in a different response order falsely blocked restart. It was reproduced first (60 passed/one failed), fixed by sorting copies only for comparison, and independently rechecked with no remaining findings. Original stored proof and packet bytes are never reordered or rewritten.

During implementation verification, no live model, paid NFL read, production DB/SSH access, report regeneration, real message, deployment or cron change occurred. Both prior retained Week 6 artifacts remain unchanged and held; previous protocol/voice acceptance does not approve their old coverage.

**Commit:** `517a31a` (`fix: enforce one queried fantasy reporting window across evidence`), with commit-only approval. The Operator pushed and reported deployment.

**Operator-run editorial-only acceptance (2026-10-21 UTC):** `preview-candidate --week 6 --nfl` returned `approved` with the fixed interval `[2026-10-14T07:00:00.000Z, 2026-10-21T07:00:00.000Z)`. Evidence `evidence-917cfdf760647a85a8b8bc8df3ae99c9fcd1ebe162449d4bbd8176b57520ba3a` admitted 66 chat sources and three NFL reads. The result had fourteen `transactions:transaction_time_unverified` gaps plus `nfl:source_player_mapping_unavailable`, `nfl:reporting_window_exclusion` and `nfl:source_partial`; unavailable temporal/player claims were not guessed. Actual credit totals are not printed by this CLI result.

One writer and one reviewer approved `fantasy-editorial-v2` candidate `candidate-8421ce2a1a7afa478ac151e0bb05fc7049ecfce9e8e14f5ffdcb59ddbb1dfb8b` as one 2,378-UTF-16-unit part, without the generated public Basis label. Database state was verified unchanged, Broadcaster was not invoked, and sends were zero. No private report/quote text is copied into this record.

This is an Operator-run read-only editorial sample, not a source-checksummed full-pipeline run, scheduled tick, durable production save/retry, provider acceptance or handset receipt. The CLI does not retain a new SavedReport; printed approval is not saved delivery authority. Recording that sample granted no further commit/push, publication or cron resumption. The separately authorized preparation and publication below used a new saved artifact, not reconstructed preview text.

## 3. Controlled first official Week 6 publication

**Operator-confirmed acceptance (2026-10-21 UTC):** the Operator chose save/review first rather than immediate generation-and-send. A read-only preflight confirmed season 2026, latest completed week 6 and no existing configured-league Week 6 run. A source-checked temporary operator runner then used the canonical durable pipeline with the exact queried window above, three NFL reads, one Astra writer and one reviewer. Its 173-file source proof matched the code at `517a31a` (the later `872d3ea` changes only acceptance documentation).

The new approved editorial-v2 artifact is `report-50efe9712a16aea0be67cf9956756d1c3927ee08584d3e77bb0b4a3faf10846c`, one 2,591-UTF-16-unit part, retained at `data/fantasy-publish-review/fantasy-week6-official-held-report.json` (0600). Approval/history and a manual recovery hold committed atomically through the existing owners before any publication callback. The report was durably held with zero send attempts; alerts were suppressed. Native disposable-PostgreSQL self-checks on macOS and Linux/Bun 1.3.14 covered hold failure rollback, lost commit acknowledgment, visible paid intents, duplicate-budget refusal and automatic-retry denial; four fresh read-only reviews found no issues. No rejected earlier artifact was edited or published.

The actual Luna/max Broadcaster then exercised these exact saved bytes with a mocked sender in a disposable isolated schema. It made two HTTP 200 model calls and one mock send; exact bytes and replay blocking passed. Production stayed held, ordinary rows and the private artifact were unchanged, and the temporary schema was removed. Real Sendblue calls were zero. Two fresh read-only reviews and native offline checks covered the mock runner's isolation and protocol.

After reviewing the text and mock result, the Operator explicitly authorized one real send of this saved report. The trusted CLI `retry --week 6 --report-id <exact ID above>` resumed only its pending part through the existing checked Broadcaster and exact sender, with no new writer, editor, research or regeneration. The receipt reported `status: sent`, `acceptedParts: 1`, `totalParts: 1`, `recoveryRequired: false` and `unresolved: null`. The Operator also confirmed seeing the report in the group chat.

This proves one controlled saved-report delivery and Operator-observed group receipt, not an automatic scheduled tick, recurring cron resumption, universal editorial quality or physical exactly-once guarantees. No schedule-run POST was used. The recurring cron remains Operator-paused; no further send, regeneration, commit/push or resumption is authorized by recording this acceptance.
