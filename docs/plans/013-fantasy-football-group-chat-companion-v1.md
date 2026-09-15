# 013: Fantasy football group chat companion V1

Status: **Stages 1-4 shipped on the branch; stage 5 in progress. Each stage carries its commit below.**

Linear: [JAM-54](https://linear.app/abdirahman-haji/issue/JAM-54/fantasy-football-group-chat-companion-passive-weekly-recap-v1).

Build one passive companion for one Sleeper league and one Sendblue iMessage group. Group messages are stored without an agent response. At 10:00 `America/Chicago` each day, a Mastra workflow checks Sleeper for a newly completed fantasy week, computes all fantasy facts in TypeScript, asks a private Fantasy Agent for a concise editorial selection, renders factual values in application code, and posts at most one recap.

## Decisions

- Reuse Jamis's existing Sendblue webhook and route locally per [ADR 0017](../adrs/0017-fantasy-group-is-passive-channel-context.md): operator direct messages invoke Jamis, the configured Fantasy group persists only, and other conversations are ignored.
- Store Fantasy group messages in one dedicated Mastra thread in Postgres. Preserve Sendblue message handle, sender number, sent timestamp, group context, text, participants, and attachment metadata. V1 gives the Fantasy Agent text only and never downloads or analyzes media.
- Map sender phone numbers to Sleeper user IDs through a private environment variable. At recap time, resolve stored messages through the current mapping so a later mapping update also fixes earlier messages. Unmapped senders receive a stable anonymous label, ingestion continues, and Jamis alerts the operator without exposing the number in logs.
- Use plain TypeScript functions for Sleeper's NFL state, league, users, rosters, weekly matchups, and winners bracket. Normalize and validate every response before analysis. No Sleeper Mastra tools.
- A non-final regular or championship week is complete only after Sleeper advances beyond it. The final championship week is complete when league status is `complete` and the championship result is resolved. `display_week`, wall-clock delays, and model judgment never decide completion.
- Cover the regular season and only the winner path leading to the championship. Exclude consolation and placement matchups. The final recap omits an upcoming matchup.
- Reconstruct standings snapshots from matchup results. Rank by wins, then total fantasy points. Report only meaningful standings context and movement. Preserve tied weekly honors instead of inventing a winner.
- Application code derives winners, losers, scores, high and low scorers, closest matchup, biggest blowout, standings context and movement, and all eligible upcoming matchups. The Fantasy Agent chooses the featured upcoming matchup from that factual list.
- For the first recap, use chat captured since feature activation. Later recaps use chat after the prior recap's effective delivery time: provider acceptance time for a normal send, or the original send-attempt time for an operator-confirmed send. Keep the newest 200 text messages or 20,000 characters, whichever limit is reached first.
- The Fantasy Agent has no tools, channel, or memory. It returns structured fact, message, and matchup references plus bounded editorial copy. Application code validates the references and renders identities, scores, records, and pairings. One repair attempt handles invalid or overlong output; a second failure closes without posting.
- Keep generation replaceable behind `facts + chat -> versioned recap generator -> final text`. Store the generator version and final text. V1 changes generation behavior through code and deployment, with no runtime experiment service.
- Recaps are at most 2,000 characters. Sports analysis leads; humor is sparse, Onion-like, and limited to fantasy results and decisions. Chat callbacks are paraphrased, optional, and never expose phone numbers.
- Incomplete Sleeper facts stop the recap and alert the operator. Missing chat context does not block a factually complete recap.
- Use the durable state model in [ADR 0018](../adrs/0018-durable-recap-state-owns-delivery-correctness.md). Safe failures retry on the next daily run. Delivery unknown always alerts immediately and requires operator resolution.
- Emit a structured ClickHouse trace and log for every success, failure, and no-op. Include league, week, recap-run ID, stage, outcome, and sanitized error. Exclude phone numbers, raw chat, and recap text. Notify the operator on the first actionable failure and once on recovery, rather than on every daily retry.
- If Fantasy configuration is absent, leave the feature disabled. If configuration is partially present or invalid, disable only Fantasy behavior, keep Jamis available, and alert the operator.

## Configuration and storage

Add these environment values to both templates:

- `FANTASY_SENDBLUE_GROUP_ID`
- `FANTASY_SLEEPER_LEAGUE_ID`
- `FANTASY_MANAGER_MAP`, a JSON object from E.164 phone number to Sleeper user ID
- `FANTASY_RECAP_TIMEZONE=America/Chicago`
- `FANTASY_RECAP_MODEL` (optional; absent or empty falls back to the shipped default recap model)

Use Bun's PostgreSQL client against the existing `DATABASE_URL`; add no database dependency or migration framework. Initialize idempotently at first use: `fantasy_recap_generations` (versioned generation history keyed on `(league_id, fantasy_week, generator_version, model)`, storing final text and the facts JSONB), `fantasy_recap_runs` (delivery state keyed on `(league_id, fantasy_week)`, storing status, final text, attempt ownership/expiry, send-attempt timestamp, provider message handle when available, delivery confirmation source, sent timestamp, sanitized error, and UTC audit timestamps), and `fantasy_unmapped_sender_alerts` (alert-once dedup per unmapped sender hash).

The scheduled workflow uses Mastra's declarative schedule with cron `0 10 * * *` and the configured IANA timezone. Keep the default in-process scheduler in the current single long-lived application container. Do not add Redis, a second worker container, or an external cron service in V1.

## Editorial recap follow-up

Implement this follow-up as two independently reviewable commits. Neither commit authorizes a production write, push, deploy, or live group send.

### 1. Curated player story candidates

**Goal:** Give the eventual editorial a small deterministic set of player facts without sending full lineups to the model.

Normalize starters, rostered players, and player points from each weekly matchup. Resolve only the needed player IDs from Sleeper's public player catalog and cache the minimal name and primary-position fields in memory for 24 hours. Derive the three highest-scoring starters league-wide, sorted by points then player ID, plus at most one bench candidate per losing roster. A bench candidate qualifies only when the benched player shares the starter's primary position and the point difference is strictly greater than the matchup loss margin. Missing catalog data removes only the affected player candidate and never blocks valid matchup facts.

**Verification:** Focused normalization and analysis tests, full repository checks, then a live read-only `inspect` against Sleeper.

**Proposed commit:** `feat: add fantasy player story candidates`

### 2. Optional closing editorial

**Status:** done. A 2026-09-14 UTC dry run used 25 mapped archived messages, rendered two editorial paragraphs with two callbacks, and left production recap rows unchanged at zero generations and zero runs.

**Goal:** Replace the standalone receipts list with an unheaded closing editorial about the week's biggest stories.

The model may return zero to four stories. Each story is its own paragraph with two to four sentences. The complete editorial is limited to 12 sentences and 180 words, with one blank line after Highlights and between stories. Stories may interpret results, consequences, contrasts, curated player facts, or supported chat context, but must not repeat a Highlight fact, another story's premise, a callback, or a joke. Exact duplicate Highlights are omitted after their first appearance.

Callbacks are optional, zero to four total, normally no more than one per story. Two are allowed only when the exchange itself is the story. Eligible context may be pregame, live, or postgame within the recap window. The model receives exact UTC timestamps and known mapped speakers only. Callback sentences reference a unique archived message ID and a `{speaker}` placeholder; application code performs deterministic attribution. Verbatim quotes, copied source phrases, unsupported chronology, invented motive, forced conclusions, and forced comedy are rejected. Humor is optional and never a quota.

If the rendered recap exceeds 2,000 characters, remove the weakest complete editorial paragraph until it fits. Never truncate a paragraph. If no story qualifies, omit the editorial completely.

**Verification:** Structured-output and renderer tests, then one archived iMessage dry run through a transaction forced read-only. Report only message count and UTC bounds, verify recap row counts before and after, and never call Sendblue.

**Proposed commit:** `feat: add fantasy recap editorial`

## Commands

One Bun script exposes the same coordinator used by the scheduled workflow:

```text
bun run fantasy:recap inspect --week <number>
bun run fantasy:recap run
bun run fantasy:recap retry --week <number>
bun run fantasy:recap confirm-sent --week <number>
```

`inspect` prints the normalized Fantasy facts without generating or sending. `run` performs the normal Sleeper reconciliation immediately. `retry` resends the stored text only when the selected run is safe to retry, no newer completed or sent week exists, and the operator has verified that any delivery-unknown message is absent. `confirm-sent` records that the operator observed the message in the group, stores the operator confirmation source, and uses the original send-attempt time as the effective delivery time. Commands use the current process environment, so the operator runs them directly on the intended local or production box.

## Delivery stages

Each stage is independently committable. For every stage: implement, run `bun test`, `bun run typecheck`, and `bun run lint`, show the diff and proposed commit, wait for explicit approval, then commit. Pushing remains a separate approval.

### 1. Passive Fantasy group ingestion

**Status:** done, commit `fa5d2d4`, IRL-verified end to end (persisted text/sender/timestamp, no group reply, operator DM intact, replayed webhook idempotent).

**Goal:** Prove the highest-risk boundary before any recap logic exists: the configured group persists durably and never invokes an agent.

**Critical files:** `.env.example`, `.env.prod.example`, `src/mastra/channels/sendblue.ts`, `src/mastra/agents/jamis.ts`, new focused Fantasy configuration and message-persistence modules, focused handler tests.

**Verification:** Send one text and one attachment-bearing message in the configured group. Confirm both appear in the dedicated Postgres thread with stable authorship and that the group receives no response. Send an operator DM and confirm Jamis still responds. Replay the same webhook and confirm one stored message.

**Proposed commit:** `feat: persist fantasy group messages without agent replies`

### 2. Sleeper normalization and deterministic analysis

**Status:** done, commit `7e45762`; live-shape probes all clean and week-1 (unflagged) comparison queued for when Sleeper advances past it.

**Goal:** Prove the fantasy source of truth independently of agents, schedules, and Sendblue delivery.

**Critical files:** new `src/fantasy/sleeper.ts`, normalized types/schemas, deterministic analysis module, fixtures and focused tests, `scripts/fantasy-recap.ts`, and the package script's read-only `inspect` subcommand.

**Verification:** Run `bun run fantasy:recap inspect --week <number>` against the configured live league and compare its matchups, high/low scores, closest game, blowout, standings movement, and championship inclusion against Sleeper. Unsupported or incomplete league data must exit without producing recap facts.

**Proposed commit:** `feat: add deterministic Sleeper recap analysis`

### 3. Versioned Fantasy recap generation

**Status:** done, commit `0b42c37`; three-model taste test run against the live league with `@mastra/pg`-backed generation history live-verified (a model-shaping validator slip surfaced and informed the digit-free free-text rule).

**Goal:** Produce reviewable final text without any outbound message.

**Critical files:** new private Fantasy Agent, structured generation schema, generator, renderer, prompt fixtures, and focused validation tests.

**Verification:** Generate a recap from a fixed fact/chat fixture. Confirm every returned reference exists, factual values come from the renderer, callbacks are paraphrases, zero callbacks is valid, the result is at most 2,000 characters, and rerunning after a prompt change records a different generator version without changing upstream facts.

**Proposed commit:** `feat: generate versioned fantasy weekly recaps`

### 4. Durable delivery and operator recovery

**Status:** done, commit `27fe00e`; born-complete DDL verified against real Postgres; accepted/failure/timeout/crash/stale fixtures covered, with atomic lease sweep and 4xx-vs-5xx outcome classes per review findings.

**Goal:** Make one league/week send retryable without duplicating an accepted message.

**Critical files:** recap-run schema/repository, shared coordinator, Sendblue group delivery wrapper, operator notifier, `scripts/fantasy-recap.ts`, package script, state-transition tests.

**Verification:** Exercise accepted, definite failure, timeout, crash-after-attempt, and stale-week fixtures. Confirm only a nonempty provider message handle marks an ordinary send `sent`, safe failures retry the identical stored text, uncertain sends become `delivery_unknown`, concurrent claims produce one outbound call, stale weeks cannot retry, and operator confirmation records its source and original attempt time. Before any live group send, show the exact generated message and obtain approval.

**Proposed commit:** `feat: add durable fantasy recap delivery and recovery`

### 5. Scheduled workflow, monitoring, and production smoke

**Goal:** Turn the proven coordinator into the passive weekly product.

**Critical files:** new scheduled workflow, `src/mastra/index.ts`, observability redaction/tests, deployment documentation if the production command changes.

**Verification:** Start the app with the production topology, confirm the declarative schedule appears with `10:00 America/Chicago`, run it manually through Mastra, and observe a no-op or completed run in ClickHouse without raw chat, phone numbers, or recap text. After approval, complete one live group send, confirm its provider message handle and `sent` record, rerun, and observe no duplicate.

**Proposed commit:** `feat: schedule and monitor fantasy weekly recaps`

## Research basis

- [Mastra scheduled workflows](https://mastra.ai/docs/workflows/scheduled-workflows): declarative workflow schedules, IANA timezone, manual and scheduled execution path, in-process topology.
- [Mastra workers](https://mastra.ai/docs/deployment/workers): missed schedule fires are not replayed and in-process crashes can leave runs stuck.
- [Mastra schedules](https://mastra.ai/reference/schedules/overview): Postgres support, durable pause/resume, and manual firing.
- [Mastra Channels](https://mastra.ai/docs/channels): webhook acknowledgement, custom-handler failure behavior, and best-effort deduplication.
- [Mastra message history](https://mastra.ai/docs/memory/message-history): manual thread/message persistence and bounded date-range recall.
- [Sleeper API](https://docs.sleeper.com/): NFL state, league, users, rosters, weekly matchups, and winners bracket contracts.
- Installed package docs and types for `@mastra/core@1.61.0`, `@mastra/pg@1.21.1`, and `chat-adapter-sendblue@0.2.0` were checked against the live documentation.

## Explicitly deferred

No transactions, waivers, research/news, power rankings, projections, win probabilities, start/sit advice, full lineup dumps, long-term lore, embeddings, chat summarizer, conversational Fantasy Agent, Jamis-triggered broadcast, multi-league support, multi-group support, media analysis, runtime A/B service, distributed workers, or custom chat-history database.
