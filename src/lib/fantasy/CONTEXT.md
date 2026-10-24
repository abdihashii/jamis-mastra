# Fantasy Companion

The Fantasy Companion passively observes one Sleeper league's iMessage group and publishes one concise recap after each completed fantasy week.

This glossary describes the current implementation. The editorial expansion in [ADR 0023](../../../docs/adrs/0023-fantasy-pundit-editorial-workflow.md) and [plan 032](../../../docs/plans/032-fantasy-pundit-editorial-workflow.md) is not implemented. It replaces the high/low/closest award definitions below with evidence-backed editorial selection, adds a genuine attributed Quote of the Week and relevant Alexandria NFL evidence, and introduces separate deterministic and editorial validation. The Fantasy Football Pundit owns the reporting; Broadcaster delivers exact saved content under application authority. Stage 1 relocates this context and support code to `src/lib/fantasy` and the existing Agent definition to `src/mastra/agents/fantasy-football-pundit.ts`, preserving current reporting and delivery behavior. The Operator's identity amendment names the Agent Fantasy Football Pundit (`fantasy-football-pundit`) and replaces the old group-facing persona; this prompt-only revision introduced generator v11. The live-smoke follow-up (v12) excludes complete three-award recap blocks, including participant reposts, from model chat context without deleting archived originals or relaxing the paraphrase checks. Preview and scheduled generation share one validated repair attempt with draft/issue feedback; a second invalid draft blocks output. Historical reports and saved retry text retain their original contract.

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
