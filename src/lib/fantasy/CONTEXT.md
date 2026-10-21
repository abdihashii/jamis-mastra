# Fantasy Companion

The Fantasy Companion passively observes one Sleeper league's iMessage group and prepares a complete editorial recap for each completed fantasy week, delivered as one to three exact ordered messages.

This describes the v13 cutover implementation of [ADR 0023](../../../docs/adrs/0023-fantasy-pundit-editorial-workflow.md) and [plan 032](../../../docs/plans/032-fantasy-pundit-editorial-workflow.md). Deployment and integrated live acceptance remain separate gates. The production cron stays Operator-paused; neither code, deployment nor preview success authorizes resumption or a controlled group send. The internal Fantasy Football Pundit owns reporting, a separate editor validates it, and Broadcaster delivers only exact saved content under application authority. Historical v10-v12 reports, SavedReport v1 digests and saved retry text retain their original contracts.

## Production composition

`pipeline.ts` is the single durable composition behind the unchanged scheduled workflow and trusted CLI `run`. It routes saved reports before acquisition or model work, then claims an unsaved attempt, collects/freezes its evidence packet, invokes the private writer/editor, atomically saves the exact approved artifact, and invokes the private publisher. A paid or interrupted attempt cannot silently receive a fresh budget. `restart --week W --attempt-id A` explicitly replaces only that blocked unsaved attempt. Routine receipts expose bounded reason/count/reference metadata, not evidence, debug, target IDs or rejected prose.

## NFL sources boundary

The league always uses HALF-PPR (Operator-confirmed; Sleeper `scoring_settings.rec = 0.5`). StartWho calls that preset `HALF` in API inputs/output and `Half-PPR` in its source URL. Provider projections still use their own scoring rules, not the league's exact Sleeper points.

`nfl-sources.ts` owns source contracts, validation and normalization; `nfl-sources-task.ts` exposes one task-local deterministic reader for official NFL regular-season injury reports, recent NFL headlines/summaries, and StartWho's current-season weekly results. Only strict public NFL fields cross the boundary; source-native player IDs are not assumed to be Sleeper IDs. One zero-credit catalogue lookup admits at most three distinct reads, each quoted at five credits. Duplicate reads reuse their result; unknown receipts, unexpected charges and access/terms failures stop further requests. The API has no upstream credit-ceiling parameter, so receipt checks cannot prevent a provider mischarge.

The caller supplies the trusted current NFL season. Older-season projections are blocked before any upstream call. Practice dates, article publication/update times, kickoff and retrieval times remain distinct; no immutable pre-kickoff snapshot or known license is inferred. Partial, empty, unpublished and truncated data remain explicit. The production composition enables this bounded reader when its configured API key exists, reserving durable paid intents first. Evidence/candidate previews invoke it only with explicit `--nfl`. No research occurs on saved-report retries.

## Frozen evidence and read-only preview

`recap-evidence.ts` owns collection, source-native player matching, temporal limitations, coverage and the frozen packet identity. Sleeper supplies season/week/completion, actual league points, rosters and transaction rounds. Only completed transactions enter the packet; pending/failed requests and their bids are not editorial context. Current catalog eligibility, final lineups and bench scores never prove a pre-kickoff opportunity. Known transaction timing and a supported kickoff can establish chronology, not managerial intent or decision quality. Current results, historical standings and upcoming pairings are derived independently, so bad future context cannot discard valid results. Optional source failures preserve independently usable facts; essential-result failures and unavailable/truncated archives block that candidate, not JAMIS. Empty/missing lineups stay unknown rather than proving a player did not start. Affirmative acquisition chronology requires a concluded, past kickoff inside the explicit evidence window; raw source dates are not automatically promoted to supported facts.

`chat-archive.ts` reads at most 1,000 stored messages/100,000 text characters in an explicit closed UTC window. Explicit previews supply dates. Production derives conservative calendar-date coverage from Sleeper's own public, undocumented NFL schedule feed: every actual target game must be complete, including delayed Tuesday/Wednesday games; coverage starts at the earliest target game date at midnight UTC and ends at collection or the next week's earliest actual game date, whichever comes first. Week 18 also checks postseason week 1. Missing, conflicting or ambiguous schedule data blocks rather than inventing a cutoff. These are stored-archive coverage dates, not official kickoff/final-whistle timestamps. Coverage means the stored window, not the entire iMessage conversation. Original single-part text and mapped attribution are retained without normalization; foreign context, unmapped senders, contact details, recognized reactions and prior recaps are excluded. `resolveChatSource` resolves exact full messages, not permission to publish them: every source still requires Stage 4 privacy/relevance review. No excerpt machinery or semantic privacy classifier is introduced here.

`archive.ts` supplies read-only, initialization-disabled archive access for both production and previews. `evidence-preview.ts` opens read-only PostgreSQL clients with initialization disabled and compares league-scoped recap/run counts and whole-row hashes around collection and any supplied candidate preparation. Changed state is reported without attributing concurrent writes to preview. Evidence-path Sleeper reads carry 20-second abort signals through response-body consumption; their lower transport layer suppresses raw errors. Source/storage exceptions return safe partial/blocked outcomes, never raw errors or empty-success substitutions. The CLI `fantasy:recap evidence --week N --since <instant> --until <instant>` prints coverage only, without model calls, source text, run/report mutations or sends. `--nfl` explicitly opts into the existing bounded paid reader. `inspect` remains facts-only. `preview` aliases the strict `preview-candidate` command; it no longer activates the old Sol/v12 writer. Neither preview initializes publication state or sends. Scheduling identity/timezone, legacy saved retries and historical text remain compatible.

## Editorial candidate contract

`editorial.ts` owns the strict structured draft, packet-local source/numeric references and deterministic candidate rendering. The Pundit selects awards rather than inheriting high/low/closest; shared honors retain unique subjects and factual matchup ties remain ties. Evidence v1 does not establish pregame decision quality, so management-based awards are rejected and accepted performance fallbacks are labeled explicitly. Optional history/player/NFL gaps withhold dependent references, not independent results; invalid historical rows are not promoted into verified numeric facts.

Names and numbers resolve from known references; quote IDs resolve full original messages and mapped attribution without normalization or recursive token expansion. Context, privacy, fairness and arbitrary prose truth still need the separate editorial gate. A structurally valid candidate is not an approved report or send authority. Zero stories/no suitable quote remain explicit; an unreadable or incomplete archive blocks the candidate.

Complete sections/stories are packed before review into at most three ordered parts, each at most 18,000 UTF-16 units including headers, below Sendblue's documented general message limit. This is a technical safety ceiling, not a word target or live group-delivery proof. Overflow returns safe path/code issues rather than truncating quotes, dropping stories or splitting during transport. Candidate identity covers the evidence ID, parsed draft and exact ordered parts; output is detached and frozen.

`editorial-policy.ts` pins the internal writer and separate tool-free editor to Astra/xhigh, one model step and zero SDK retries. `editorial-loop.ts` projects the same bounded packet for both roles, checks deterministic rendering before each review and binds the review to the exact evidence/candidate IDs and ordered parts. Specific issues return only to the writer. At most two revisions (three drafts and three reviews), 600 seconds per call and 1,800 seconds total are allowed; malformed/stale reviews, outages, cancellation and exhaustion block rather than fall back. The closed native `prepare_fantasy_recap` procedure grants only its writer/editor edges, passes no Operator memory or phone/group metadata, registers no public roots/workflow, and disables snapshots/restarts. Its private runtime shares gateways/logger/tracing but hides storage, including from Mastra's internal agent-loop checkpoints. First-event telemetry protection includes both agents, checked targets and private workflow/step identities.

`preview.ts` uses the existing read-only owner around collection and the complete native editorial operation, not just evidence gathering. Schema initialization, report/run changes, snapshot writes and sends are not part of this path. Changed/unverified database state or cleanup failure withholds the approved artifact, retaining only safe attempt counts. `fantasy:recap preview-candidate --week N --since <instant> --until <instant> [--nfl]` prints only a fully reviewed candidate or a safe block. Each explicit preview has one in-memory budget, with no autonomous restart, durable debug persistence or publication authority. Production uses the durable generation owner below. The root/string-based Sol/v12 writer is retired; the separate Operator one-off drafter and next-message confirmation owner are unchanged.

## Saved report delivery boundary

`saved-report.ts` validates an approved outcome against the same frozen packet, reconstructs the exact candidate and matching final pass, and creates a detached immutable report. Its digest covers the exact ordered parts, configured league/season/week/group, candidate/evidence IDs and pinned version/model/effort/count metadata. Parsing restores canonical field order after JSONB storage. The report retains the selected publishable quote, not the full evidence packet, unselected chat, raw drafts, review prose or prompts. A valid report ID is integrity metadata, not permission to publish.

The existing run and generation tables remain the only owners. `recaps.ts` saves the complete new-format report and its versioned history atomically under the live claim, without overwriting a different artifact or historical facts shape. `runs.ts` keeps part progress on that same league/week row. A claim reserves one delivery operation, each part receives a durable attempt identity before transport, and accepted parts are skipped on every subsequent attempt. Superseded uncertain attempts stay attributable so a late acceptance is not discarded. Provider acceptance is not proof of handset receipt, and an Operator absence observation does not cancel a possibly pending post or establish exactly-once delivery.

`saved-report-delivery.ts` uses only exact saved parts and the application-bound target. It sends sequentially, never splits or normalizes content, and stops the tail on uncertainty. Confirmation records only the named unknown part; if a tail remains, the recovery hold prevents automatic continuation until a separate explicit retry. A definite rejection can remain automatically retryable. Dispatch checks the claim and wall-clock lease after a bounded league lock; late receipts are fenced by attempt identity instead, so expiry cannot erase an observed effect. Legacy whole-string writers, mutations, retries and sweeping refuse either populated new-format column rather than flattening the report. Legacy null/null rows preserve their original path.

Stage 5.1 adds no public agent/tool/workflow, model call, new CLI publication branch or scheduled cutover. Its source-pinned deployment smoke passed using real PostgreSQL in a disposable isolated schema and seven mocked sends; normal recap-run/generation counts and whole-row hashes stayed unchanged, and the schema was removed. This is storage/recovery proof, not real provider or handset delivery. The generation owner below supplies private retention and a fixed forty-five-minute reservation for the integrated pipeline. Legacy saved-message recovery retains its historical owner without reopening generation. The production cron remains Operator-paused.

## Checked Broadcaster

The private `publish_fantasy_recap` procedure alone may invoke `broadcaster`, pinned to Luna/max, two model steps, 120 seconds and zero SDK retries. Its one strict empty-argument tool receives the report reference, live claim, SQL owner and exact sender from the application, never from model-authored fields. The existing private authority map checks the actual native workflow and gives only this callee a delivery-only grant tied to its live parent; serialized/forged contexts, Jamis and the preparation/preview workflow cannot borrow it. The agent has no channels, memory or other tools. Both private procedures share `StorageFreeRuntime`, which hides application storage and internal agent-loop checkpoints while retaining gateways and protected tracing; no public agent/workflow is registered.

The delivery promise is memoized before asynchronous dispatch, while the existing run owner fences recreated/concurrent invocations. Broadcaster-only output processors validate parsed empty-object arguments before execution and disable eager tools, preventing missing/unrecoverable arguments from silently defaulting to an authorized call. Native workflow steps contain raw model errors before framework error logging. Cancellation or initialization failure holds an owned unreserved claim for explicit Operator recovery. A model handback is a contribution, not an effect receipt. The procedure waits for an already-started delivery and reconciles the existing row after refusal, malformed output, cancellation or a later model failure. It never invokes a second sender to repair the contribution, and a later unavailable read cannot retract an observed authoritative result. No report text, configured target or claim token enters the model assignment.

`saved-report-recovery.ts` adds exact report/part/attempt selectors to the Operator CLI. New-format `confirm-sent` records only the matching unknown part without initializing a model or transport; held tails need a separate explicit retry. An acknowledged confirmation retains its known accepted counts if later SQL reads are unavailable; known completion is not reported as requiring recovery. Eligible saved retries construct only the checked publisher, never research, a writer or editorial review. Partial selectors fail closed rather than falling through to legacy whole-string recovery. Recovery JSON contains bounded status/reference metadata, not report text, target IDs, claims or raw errors. Legacy valid commands and the separate one-off reviewed-draft confirmation flow retain their owners. Trusted local `run` uses the same configured publication composition as the schedule, not a new arbitrary-send command. Preview never receives send permission. Held delivery records one recovery notification on the existing row with exact report/part/attempt selectors; notification failure cannot change an effect or resend it. Review a real-data report and test those exact saved parts through the mocked Broadcaster before any separately authorized controlled group send; do not regenerate or rewrite them afterward.

## Durable generation safeguards

`generation-state.ts` checks the versioned `fantasy-generation-v1` data without owning execution. Its `fantasy-recap-v13` orchestration stamp is separate from SavedReport v1 and historical Sol/v12 artifacts; the old writer is no longer registered. `generation-runs.ts` owns the new nullable `editorial_attempt` JSONB on the existing league/week row. It uses the same bounded league/row locks and database wall clock as delivery: a fixed forty-five-minute reservation, forty-minute work deadline, and durable NFL/writer/reviewer intents before dispatch. Counts and the thirty-minute editorial deadline cannot reset on another invocation. A lost reservation acknowledgement consumes the intent, not permission to repeat it; elapsed reservation/commit time is deducted before handing a remaining timeout to execution.

Interrupted or paid-work failures stay blocked. Only an explicitly recorded source-only failure with no paid intent is automatically replaceable. An exact blocked-attempt selector may create a new unsaved attempt, preserving prior audit records and unexpired bundles; saved publication text or a delivery attempt prevents this restart. Legacy claims, mutations, sweeps and history writers refuse any non-null generation tag. Tagged approval storage reconstructs the captured draft and matching final pass and atomically binds the same attempt, evidence, candidate and unchanged SavedReport v1 history. Late outputs remain private diagnostics, but cannot promote a candidate, authorize another call or satisfy approval after their call deadline.

`generation-capture.ts` binds private typed capture to one attempt. Its fatal latch survives optional NFL-source exception handling. The native preparation observer reserves before model execution and captures typed completed/partial/progress output before post-generation cancellation discards it; previews without an observer retain their existing read-only behavior. Debug retains the frozen packet as its original JSON string, preserving the content-addressed property order through JSONB, plus typed produced outputs. It never stores SDK/auth envelopes, credentials, executable grants or hidden model reasoning. Bundles expire thirty days after the attempt starts; payload-only purge preserves audit metadata, approved reports, historical facts and the source archive.

The trusted Operator CLI `debug-export --week W --attempt-id A` opens a read-only database connection and writes only a private, non-overwriting `0600` file under `data/fantasy-debug` (`0700`). Stdout contains bounded file/reference metadata, never bundle contents. Export rejects expired data immediately using the database clock and rechecks expiry after writing; managed-file purge removes only validated expired exports. Moved copies are Operator-owned. `FantasyDebugMaintenance` runs both private purges independently at startup and daily, with no overlapping work and bounded shutdown draining. It is independent of the paused publication cron. The integrated owner applies a forty-minute work cap inside the forty-five-minute reservation. Authenticated HTTP mutations of the scheduled and private preparation/publication workflow IDs are denied; internal native grants remain mandatory. No Pundit, editor or Broadcaster root is exposed. Nothing resumes the Operator-paused cron or authorizes a controlled group send.

## Language

**Fantasy group**:
The configured fantasy-football iMessage group whose conversation supplies context for the Fantasy weekly recap. Its participants are contextual contributors, not agent operators.
_Avoid_: fantasy chat, league chat

**Fantasy manager**:
A Sleeper league participant who controls a roster and may also participate in the Fantasy group.
_Avoid_: owner, player (ambiguous), user (ambiguous)

**Completed fantasy week**:
A fantasy week whose results Sleeper has finalized by advancing beyond that week, or by recording the final championship result.
_Avoid_: last week, finished week

**Fantasy facts**:
League results, comparisons, and standings context established from Sleeper data. They are authoritative inputs to the Fantasy weekly recap.
_Avoid_: agent analysis, recap claims

**Manager of the Week**:
An editorial award for the strongest supported positive case. Evidence v1 cannot establish pregame decision quality, so its explicitly labeled performance fallback is not an automatic highest-score award. Genuine editorial ties may share honors.

**Loser of the Week**:
An editorial award for the most defensibly roast-worthy supported failure, not an automatic lowest-score award. Evidence v1 uses the explicit performance fallback rather than inventing bad management; genuine editorial ties may share honors.

**Match of the Week**:
The most compelling supported contest, not automatically the smallest margin. Shared selections are allowed when equally supported; tied scores remain factual ties.

**Fantasy weekly recap**:
One league-wide editorial report about a completed fantasy week, grounded in Fantasy facts, relevant Fantasy group conversation and admitted NFL evidence. It consists of up to three reviewed ordered messages.
_Avoid_: weekly recap (ambiguous), weekly report, team recap

**Story of the Week**:
A paragraph interpreting a worthwhile story from Fantasy facts or relevant Fantasy group conversation, including awarded performances. Humor is optional and should be immediately understandable; roasting targets fantasy performance rather than personal traits or real-life circumstances, and stories earn their place through substance rather than filling a quota.

**Fantasy recap chat context**:
The Fantasy group conversation considered while composing one Fantasy weekly recap.
_Avoid_: memory, lore, chat summary

**Fantasy recap generator**:
The editorial component that turns Fantasy facts and Fantasy recap chat context into final message text.
_Avoid_: recap pipeline (too broad), permanent template

**Fantasy Football Pundit**:
The channel-less agent (`id: 'fantasy-football-pundit'`) that currently composes Fantasy weekly recaps from supplied Fantasy facts and bounded stored Fantasy group messages. Fantasy group channel events never invoke it directly, and it does not fetch fantasy data itself.
_Avoid_: Jamis, fantasy bot

**Fantasy recap run**:
The durable lifecycle for one league and completed fantasy week. It may contain multiple processing or send attempts before reaching a final outcome.
_Avoid_: cron run, workflow run

**Fantasy recap attempt**:
One execution or outbound send try within a Fantasy recap run.
_Avoid_: Fantasy recap run

**Delivery unknown**:
A Fantasy recap run whose outbound message may have been accepted but did not receive a decisive response. It requires operator resolution before another send.
_Avoid_: failed delivery, failed recap

**Standings movement**:
The change in a Fantasy manager's league rank from the prior completed week to the newly completed week.

**Championship bracket**:
The postseason matchups that can advance a roster toward the league championship. It excludes consolation matchups.
_Avoid_: playoffs (ambiguous), postseason (ambiguous)
