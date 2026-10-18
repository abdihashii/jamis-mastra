# Fantasy Companion

The Fantasy Companion passively observes one Sleeper league's iMessage group and publishes one concise recap after each completed fantasy week.

This glossary describes the current implementation. The expanded production editorial workflow in [ADR 0023](../../../docs/adrs/0023-fantasy-pundit-editorial-workflow.md) and [plan 032](../../../docs/plans/032-fantasy-pundit-editorial-workflow.md) is not active. Its source reader and frozen evidence preview are separate off-live components. It replaces the high/low/closest award definitions below with evidence-backed editorial selection, adds a genuine attributed Quote of the Week and relevant Alexandria NFL evidence, and introduces separate deterministic and editorial validation. The Fantasy Football Pundit owns the reporting; Broadcaster delivers exact saved content under application authority. Stage 1 relocated this context and support code to `src/lib/fantasy` and the existing Agent definition to `src/mastra/agents/fantasy-football-pundit.ts`, preserving current reporting and delivery behavior. The Operator's identity amendment names the Agent Fantasy Football Pundit (`fantasy-football-pundit`) and replaces the old group-facing persona; this prompt-only revision introduced generator v11. The live-smoke follow-up (v12) excludes complete three-award recap blocks, including participant reposts, from model chat context without deleting archived originals or relaxing the paraphrase checks. Preview and scheduled generation share one validated repair attempt with draft/issue feedback; a second invalid draft blocks output. Historical reports and saved retry text retain their original contract.

## NFL sources boundary (off the live path)

`nfl-sources.ts` owns source contracts, validation and normalization; `nfl-sources-task.ts` exposes one task-local deterministic reader for official NFL regular-season injury reports, recent NFL headlines/summaries, and StartWho's current-season weekly results. Only strict public NFL fields cross the boundary; source-native player IDs are not assumed to be Sleeper IDs. One zero-credit catalogue lookup admits at most three distinct reads, each quoted at five credits. Duplicate reads reuse their result; unknown receipts, unexpected charges and access/terms failures stop further requests. The API has no upstream credit-ceiling parameter, so receipt checks cannot prevent a provider mischarge.

The caller supplies the trusted current NFL season. Older-season projections are blocked before any upstream call. Practice dates, article publication/update times, kickoff and retrieval times remain distinct; no immutable pre-kickoff snapshot or known license is inferred. Partial, empty, unpublished and truncated data remain explicit. Only the explicit evidence preview's `--nfl` option invokes this reader. The scheduled generator, legacy model preview, agents and delivery path remain unchanged.

## Frozen evidence preview (off the live path)

`evidence.ts` owns collection, source-native player matching, temporal limitations, coverage and the frozen packet identity. Sleeper supplies season/week/completion, actual league points, rosters and transaction rounds. Only completed transactions enter the packet; pending/failed requests and their bids are not editorial context. Current catalog eligibility, final lineups and bench scores never prove a pre-kickoff opportunity. Known transaction timing and a supported kickoff can establish chronology, not managerial intent or decision quality. Current results, historical standings and upcoming pairings are derived independently, so bad future context cannot discard valid results. Optional source failures preserve independently usable facts; essential-result failures and unavailable/truncated archives block that candidate, not JAMIS. Empty/missing lineups stay unknown rather than proving a player did not start. Affirmative acquisition chronology requires a concluded, past kickoff inside the explicit evidence window; raw source dates are not automatically promoted to supported facts.

`chat-evidence.ts` reads at most 1,000 stored messages/100,000 text characters in an explicit closed UTC window. The caller supplies the dates; Sleeper's documented state does not establish historical UTC rollover timestamps. Coverage means the stored window, not the entire iMessage conversation. Original single-part text and mapped attribution are retained without normalization; foreign context, unmapped senders, contact details, recognized reactions and prior recaps are excluded. `resolveChatSource` resolves exact full messages, not permission to publish them: every source still requires Stage 4 privacy/relevance review. No excerpt machinery or semantic privacy classifier is introduced here.

`preview-evidence.ts` opens read-only PostgreSQL clients with initialization disabled and compares league-scoped recap/run counts and whole-row hashes before/after collection. Changed state is reported without attributing concurrent writes to preview. Evidence-path Sleeper reads carry 20-second abort signals through response-body consumption; their lower transport layer suppresses raw errors. Source/storage exceptions return safe partial/blocked outcomes, never raw errors or empty-success substitutions. The CLI `fantasy:recap evidence --week N --since <instant> --until <instant>` prints coverage only, without model calls, source text, run/report mutations or sends. `--nfl` explicitly opts into the existing bounded paid reader. Existing `inspect`, v12 model `preview`, scheduled `run`, retries and saved text retain their contracts; the new collector is not wired into production scheduling. Automatic scheduled window selection remains an activation gate.

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
The facts-only Fantasy weekly recap award for the highest score in the completed fantasy week. Tied highest scorers share the award.

**Loser of the Week**:
The facts-only Fantasy weekly recap award for the lowest score in the completed fantasy week, regardless of matchup outcome. Tied lowest scorers share the award.

**Match of the Week**:
The facts-only Fantasy weekly recap award for the closest matchup in the completed fantasy week. Matchups tied for the smallest margin share the award.

**Fantasy weekly recap**:
One league-wide editorial message about a completed fantasy week, grounded in Fantasy facts and relevant Fantasy group conversation.
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
