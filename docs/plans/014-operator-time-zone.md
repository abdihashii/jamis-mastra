# 014: Deterministic operator time zone

Status: **Planned.**

Linear: [JAM-56](https://linear.app/abdirahman-haji/issue/JAM-56/add-deterministic-operator-time-zone).

Keep runtime clocks and stored instants in UTC while making every unqualified date boundary and user-facing timed result deterministic in the operator's declared IANA time zone. The effective zone is a persisted override when present, otherwise the deployment default `OPERATOR_TIMEZONE`.

See [ADR 0019](../adrs/0019-operator-time-zone.md). The canonical term is **operator time zone**, not app timezone or detected location.

## Required behavior

| Concern | Rule |
| --- | --- |
| Effective zone | Persisted override, otherwise required `OPERATOR_TIMEZONE` |
| Physical location | Unknown unless explicitly supplied for the current task; never inferred from the operator time zone |
| Instants | Store and exchange as UTC ISO 8601 |
| Civil dates | Keep date-only values as `YYYY-MM-DD`; never invent midnight |
| Calendar | Build day windows in the operator zone; show timed events in the operator zone; preserve all-day dates |
| Gmail | Keep `internalDate` as the canonical UTC instant; compute relative-day UTC bounds from the operator zone and filter by `internalDate` in code |
| Weather | Resolve unqualified relative dates in the operator zone; keep destination-local clocks labelled with their offset or zone |
| Fantasy | Keep `FANTASY_RECAP_TIMEZONE` stable and independent |
| Chat change | Propose the exact IANA value, require the immediately following operator DM to confirm, persist globally until changed or reset |
| Bad config | Fail deployment preflight before replacing the healthy app; reject invalid chat proposals immediately |

Example: if the operator says "I'm in Denver," Jamis may acknowledge that statement and propose `America/Denver`. After confirmation, deterministic state records only `America/Denver`, not a live location. Later, the time zone alone cannot answer "Where am I?" If no override exists, Jamis reports the deployment default and identifies it as such.

## Non-goals

- Physical-location detection or travel inference.
- Multi-user time-zone preferences.
- A generic settings table, arbitrary database write tool, or separate authenticated HTTP API.
- Converting Calendar all-day dates into instants.
- Changing Fantasy recap scheduling.
- Migrating existing stored instants or adding a time-zone-specific uptime service.

## Stage 1: Deterministic preference and current time

**Goal:** establish one tested source of truth before any integration depends on it.

**Critical files:** `src/lib/time.ts`, a narrow operator-time-zone persistence module, `src/mastra/env.ts`, `src/mastra/agents/jamis.ts`, `.env.example`, `.env.prod.example`, `infra/deploy.sh`, focused tests.

**Acceptance criteria:**

- `OPERATOR_TIMEZONE` is a required IANA zone. Validation uses the platform `Intl` implementation and adds no dependency.
- A singleton Postgres record stores only the optional override and UTC audit timestamps. It is not a generic key/value settings store.
- One resolver returns the effective zone and source (`override` or `default`). One current-time tool returns `nowUtc`, the effective IANA zone, and an offset-bearing operator-local date-time. Tests inject the clock.
- Missing or invalid deployment config exits nonzero before Compose replaces the running app and prints the exact corrective action. Boot also rejects invalid config.
- DST transitions and a UTC/local date rollover are covered by focused tests.

**Demo:** execute the current-time tool with no override, set a fixture override, and execute it again. Observe the same UTC instant represented under the two expected IANA zones. Run the deploy preflight against missing and invalid values and observe a nonzero exit before `docker compose up`.

**Proposed commit:** `feat: add deterministic operator time zone`

## Stage 2: Apply the operator zone to read paths

**Goal:** remove model-side and provider-implicit time-zone arithmetic from Calendar, Gmail, and Weather.

**Critical files:** `src/lib/time.ts`, `src/mastra/tools/calendar-events.ts`, `src/mastra/tools/gmail-search.ts`, `src/mastra/tools/weather-tool.ts`, related agent instructions and focused tests.

**Acceptance criteria:**

- Calendar windows use the effective operator zone. Timed events expose a canonical UTC instant plus an operator-local presentation; all-day start/end remain bare dates.
- Gmail relative-day filters compute an operator-local day window, convert its boundaries to UTC, and filter fetched messages against numeric `internalDate`. Provider search-date timezone semantics are not trusted for correctness.
- Weather resolves `today`, `tomorrow`, and weekdays from the operator zone. Forecast entries still bucket by the destination's local calendar date. Destination-local current time, sunrise, and sunset include an explicit offset or zone label.
- At the Chicago/Tokyo rollover edge, `tomorrow` selects the operator's next date. Calendar timed events crossing zones present the equivalent operator-local time. DST boundary fixtures remain deterministic.
- `FANTASY_RECAP_TIMEZONE` behavior and stored UTC instants are unchanged.

**Demo:** run focused tool fixtures for a Calendar timed event and all-day event, Gmail messages on both sides of operator midnight, and Tokyo weather while the operator's date differs. Observe no model-side date math.

**Proposed commit:** `feat: apply operator time zone to agent date handling`

## Stage 3: Confirmed conversational changes

**Goal:** let the operator change or reset the durable override from the existing iMessage thread without creating a general write surface.

**Critical files:** the operator-time-zone module, `src/mastra/agents/jamis.ts`, `src/mastra/channels/sendblue.ts`, focused tests, setup documentation.

**Acceptance criteria:**

- Jamis maps natural phrasing such as "I'm in Denver" to a proposed IANA value and shows `America/Denver` before any write. Application code validates the exact IANA value.
- The mutation is callable only from the authenticated operator's direct Sendblue thread. Missing channel context, group traffic, other senders, subagents, and direct API tool execution cannot mutate it.
- The proposal stores one exact target and its source thread/message identifiers. Only explicit confirmation in the immediately following operator DM may apply that target. Decline or any unrelated next message clears it. A later `yes` cannot revive it.
- Reset is also confirmed, then clears the override and reveals the deployment default.
- A successful change reports the effective zone and source. "Where am I, and what is my operator time zone?" reports that physical location is unknown, plus the exact effective IANA zone and whether it came from the override or default.
- Invalid proposals are rejected immediately in channel. Concurrent or replayed confirmations cannot apply twice.

**Demo:** over the real iMessage DM, propose and decline a zone; propose then send an unrelated message and verify a later `yes` does nothing; propose and confirm a zone; restart the app and verify it persists; reset and verify fallback to `OPERATOR_TIMEZONE`. Confirm the same operations fail from a non-operator context.

**Proposed commit:** `feat: add confirmed operator time zone changes`

## Final gate

Run `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`, and `git diff --check`. Then repeat the Calendar, Gmail, Weather, iMessage, restart, and deployment-preflight smokes above. Implement and verify one stage at a time; show the diff and wait for explicit sign-off before each commit. Pushing requires separate confirmation.
