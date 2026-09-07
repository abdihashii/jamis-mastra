# Fantasy Companion

The Fantasy Companion passively observes one Sleeper league's iMessage group and publishes one concise recap after each completed fantasy week.

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

**Fantasy weekly recap**:
One league-wide editorial message about a completed fantasy week, grounded in Fantasy facts and relevant Fantasy group conversation.
_Avoid_: weekly recap (ambiguous), weekly report, team recap

**Fantasy recap chat context**:
The Fantasy group conversation considered while composing one Fantasy weekly recap.
_Avoid_: memory, lore, chat summary

**Fantasy recap generator**:
The editorial component that turns Fantasy facts and Fantasy recap chat context into final message text.
_Avoid_: recap pipeline (too broad), permanent template

**Fantasy Agent**:
The private agent that composes Fantasy weekly recaps from supplied Fantasy facts and bounded stored Fantasy group messages. Fantasy group channel events never invoke it directly, and it does not fetch fantasy data itself.
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
