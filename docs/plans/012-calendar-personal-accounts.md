# 012: Google Calendar read-only via personal-accounts-agent

Status: **Complete.** Production verification 2026-09-05 UTC.

- Branch `JAM-52-extend-personal-accounts-agent-with-read-only-google`, PR #23.
- Stage 1 (superset scope + login pool picker): `727afa7`, 90 tests, real
  `login:google` capture on Mac (0600, 3 scopes, 6-calendar pool picked).
- Stage 2 (`calendar-events` tool + agent wiring): `1363197`, 114 tests, live
  `mastra api tool execute` sanity against the real primary-plus-pick pool.
- Stage 3 (setup-gmail.md Calendar section + skip-flag pool preservation): `50e151f`.
- Stage 4 (prod): re-captured credential on VPS over `ssh -L` against the
  JAM-52 branch checkout (0600, uid 1000, superset 3 scopes, 6 calendars).
  Deployed via `infra/deploy.sh` with `JAMIS_BRANCH=JAM-52-...`.
  `tool list` shows `calendar-events`; `tool execute '{"daysAhead":1}'`
  returns real events from prod (Walmart Delivery, LGI FF Draft).
  iMessage smoke: "what's on my calendar tomorrow?" → Jamis answered with a
  real empty-day list for Sunday 2026-09-06, proving per-calendar
  window logic end to end. Silent-refresh proven by back-dating `expiresAt`
  on the box and re-executing the tool (access token rotated in place, file
  rewritten with future expiry).
  Post-deploy leak scans: Postgres `mastra_messages` clean (0 hits for
  `calendar.events.readonly` / `calendarlist` / `ya29.`), ClickHouse
  `mastra_span_events` clean across attributes/input/output/error/requestContext.

Known v1 cut corners: all-day multi-day spans keep bare dates (Jamis relays
"all day" fine); pool change = re-run `login:google` (established in plan);
calendar events with >20 hits per window surface only as `truncated: true`.

Linear: [JAM-52](https://linear.app/abdirahman-haji/issue/JAM-52/extend-personal-accounts-agent-with-read-only-google-calendar-v1).

Jamis answers calendar questions ("what's on my calendar tomorrow?") over iMessage, via the existing `personal-accounts-agent` subagent per [ADR 0015](../adrs/0015-personal-accounts-agent.md). One new tool, `calendar-events`, returning chronological event data (title, start/end, location, description). Scope stays sensitive (not restricted), sharing the same consent screen and desktop OAuth client as Gmail. The credential at `data/google-oauth.json` is extended from `gmail.readonly` to a superset scope set by re-running `login:google`.

## Decisions

Resolved in a grill-with-docs session on 2026-09-05 against ADR 0015, ADR 0016, and the research basis below.

- **Scope set is `gmail.readonly` + `calendar.events.readonly` + `calendar.calendarlist.readonly`.** Both calendar scopes are sensitive, not restricted (verified against the consent-screen scope docs and the Calendar API reference: `events.list` lists `calendar.events.readonly` and `calendarList.list` lists `calendar.calendarlist.readonly` as acceptable). No new restricted-scope verification path, no security-assessment implication, no change to the in-production unverified-app posture established in plan 011. The credential file continues to hold exactly the scopes Jamis uses; adding a fourth one later (Drive, Contacts) follows this same pattern.
- **One credential file, superset scope set.** `data/google-oauth.json` keeps being the only Google credential; the Gmail half is untouched structurally. `checkScope` widens from exact-equality against `GMAIL_READONLY_SCOPE` to membership-set verification: the set of granted scopes must contain every scope Jamis needs. Smallest delta; no second file, no second login-script plumbing. Re-running `login:google` with the larger scope set refreshes the stored credential in place (Google re-issues a token with the new scope list on `access_type=offline + prompt=consent`).
- **Calendar pool is picked once at login, stored in the credential file.** `calendar.calendarlist.readonly` exists purely so `login:google`, after capturing tokens, can print the operator's calendars (name, id, timeZone) and store the operator's picks under a new `calendars` key on the credential JSON. On every ask the tool then queries exactly those stored ids. There is no per-ask calendar-discovery call; the list fetched at login is the source until the next login run. Pool change = re-run `login:google`, no partial state.
- **`calendar-events` tool shape: `{ daysAhead, q? }`.** `daysAhead` (default 1) becomes `timeMin = start of "today" in the primary calendar's zone` and `timeMax = start of day + daysAhead in that zone`, both RFC3339 with mandatory offset, matched to `events.list`'s offset semantics. `q` passes through to the free-text search param on `events.list` (matches title, description, location, attendee names, etc.), enabling "when is my next dentist" asks without a new tool. `maxResults` is capped at 20; pagination is deliberately not exposed in v1 — if more than 20 events match the window, the response says so and asks the caller to narrow q/daysAhead.
- **Time-zone rule per ADR 0016, extended, in code.** Day boundaries resolve in the primary calendar's local timezone (carried on the credential by login, per the picker storage). Per-calendar events keep their own time zones in the output data; Jamis gets a start/end pair in ISO, zone-tagged. The model does no offset arithmetic.
- **Output per event: `title`, `start`, `end`, `location?`, `description?`.** Includes description because join links and meeting notes live there and "send me the link" is a standard iMessage ask. All fields are subject to Gmail's standing trace-boundary per ADR 0013 (ClickHouse truncation at 1024 chars; Postgres keeps the full tool result), per ADR 0015's accepted on-box posture.
- **Error relay mirrors gmail-search's contract.** `401` after the silent-refresh cycle → the generic `Authentication failed. The error was logged.`; `429` → "Calendar is rate-limited, try again later"; 5xx → "Calendar is having trouble."; shape-unreachable → "Calendar returned unusable data."; no calendar pool stored → channel-level generic auth text from the credential side. The subagent's instructions gain parallel relay phrasing per gmail's weather-agent style.
- **No freebusy in v1.** `freebusy.query` answers "am I free at 2pm Friday" cheaply but adds a calendar-list-based derive-or-fetch step the same answers can get from merged event data fast enough. Added later if observed asks reveal a latency or correctness gap.
- **jamis.ts gains no new line.** The existing routing line "Delegate personal-account requests (Gmail today, Calendar later) to personalAccountsAgent" already routes calendar asks. The Stage 3 commit amends only the routing-line wording if the concrete delegation behavior exposes drift in test.

## Research basis

All claims verified against Google primary sources scraped into `.firecrawl/` on 2026-09-05:

| Claim | Source |
| --- | --- |
| Calendar scopes are sensitive (not restricted) | `.firecrawl/google-oauth-scopes.md` (classifications), `.firecrawl/google-restricted-scope-verification.md` |
| `events.list` accepts `calendar.events.readonly` | `.firecrawl/calendar-events-list.md` Authorization section |
| `calendarList.list` accepts `calendar.calendarlist.readonly` | `.firecrawl/calendar-list-list.md` Authorization section (disproving the StackOverflow "403 workaround" rumor) |
| `events.list` params: `timeMin`/`timeMax` (RFC3339 offset mandatory), `singleEvents`, `orderBy:startTime` (only with `singleEvents`), `maxResults` (max 2500), `q` free-text, `nextPageToken`, `nextSyncToken` | `.firecrawl/calendar-events-list.md` parameter table |
| `q` searches title/description/location/attendee displayName/email/organizer fields | `.firecrawl/calendar-events-list.md:340` |
| `freebusy.query` scope is `auth/calendar.events.freebusy`; note says "authorization optional" (public calendars) | `.firecrawl/calendar-freebusy-query.md` |
| Consent-screen posture carries over from plan 011 | `.firecrawl/google-oauth-web-server.md` + Google OAuth guides already on disk |

## Public interface changes

- `src/lib/google-oauth.ts`: `GMAIL_READONLY_SCOPE` becomes `GOOGLE_REQUIRED_SCOPES: readonly string[]`. `checkScope(scope)` checks that the granted set contains every required scope (small superset of containing, no change for gmail.readonly holders). New `calendars?: Array<{ id, summary, timeZone, primary? }>` optional key on the credential shape.
- `scripts/google-login.ts`: after the credential write, prints the operator's calendars via `calendarList.list` (name + zone), prompts for picks (comma-separated numbers), stores them on the credential, rewrites with 0600. New `GOOGLE_LOGIN_CALENDAR_POOL=skip` env flag exits without prompting for future minimal re-logins where we shouldn't touch the pool.
- New `src/mastra/tools/calendar-events.ts`, test at `src/mastra/tools/__tests__/calendar-events.test.ts`. Tool input `z.object({ daysAhead: z.number().int().min(1).max(90).default(1), q: z.string().optional() })`.
- `src/mastra/agents/personal-accounts-agent.ts`: adds `calendarEventsTool` to `tools`; instruction block gains the calendar relay rules and the "calendar question -> calendarEventsTool" routing line for the subagent.
- No changes to `src/mastra/index.ts`, no changes to `src/mastra/agents/jamis.ts` (routing line is already correct, see Decisions).

## Stage plan (same 4-stage rhythm as plan 011)

1. **Credential widening** — `google-oauth.ts` set-membership scope check, optional `calendars` field on the shape, `login:google` calendar-pool picker behind the new flag, tests. Commit: `feat: extend Google credential to superset scopes and calendar pool`. Independent of tool code.
2. **calendar-events tool + agent wiring** — the tool, the agent tool registration, personal-accounts-agent instruction lines. Local `mastra api tool execute` verification with a mail and calendar ask. Commit: `feat: add calendar-events tool to personal-accounts-agent`.  
3. **Setup docs** — extend `docs/setup-gmail.md` with a Calendar section covering the scope addition, superset re-login flow, pool re-pick route, and the America/Chicago day-boundary rule. Commit: `docs: extend setup guide for Google Calendar`.
4. **VPS: re-login + AC sweep** — re-run `login:google` over `ssh -L` on the box, verify `data/google-oauth.json` carries the two new scopes plus the picked calendar pool, live iMessage "what's on my calendar tomorrow", clickhouse + Postgres scan clean. Same 4-stage commits pattern as plan 011.

Per-stage rhythm follows plan 011: implement, `bun test` + typecheck + lint, `/code-review` plus `/ponytail-review` passes, apply verified fixes, await ok, commit, move on.

Verification delta: candidly record any AC found untestable after research rather than fudging it.
