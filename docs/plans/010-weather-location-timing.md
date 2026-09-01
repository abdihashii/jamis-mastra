# 010: Weather questions — location via checks, relative dates resolved in the destination's zone

Status: **Planned. Awaiting implementation.**

Weather requests need two context facts the channel never supplies: where the operator is, and what "tomorrow" or "next Saturday" resolves to. The design answers both without any stored state: a missing or unclear place is a plain-text check owned by the weather agent, and relative date words resolve deterministically inside `forecastTool` against the destination's local zone. The durable reasoning is in [ADR 0016](../adrs/0016-weather-location-and-timing-via-checks.md). The existing weather changes on this branch are reshaped to this design before commit.

## Decisions

- **No operator-location state anywhere.** No env var, no memory writes, no device inference. Stored locations go stale the moment the operator travels; the only source of truth is the operator.
- **weatherAgent owns weather checks.** If a weather request names no usable place, weatherAgent asks in plain text before calling tools. jamis delegates anything weather-shaped unconditionally; the old jamis bullet that screened for location before delegating is removed (one owner, no duplicated checks). This also puts forecast questions on the weather path, so `forecastTool` becomes reachable over iMessage.
- **Relative dates resolve in the destination's zone, in code.** `forecastTool` accepts `day` ('monday'...'sunday') for day-name phrasings and keeps `date` (YYYY-MM-DD) for absolute references; exactly one is required. The model never does offset arithmetic.
- **Weekday rule is nearest-upcoming, inclusive of today.** `(targetDow − todayDow + 7) % 7`. Saying "Saturday" on a Saturday means today's remaining hours — matching conversational usage and guaranteed inside the 5-day window. Ambiguous phrasing is a check, not a guess.
- **Everything resolves deterministically and is unit-testable.** Date math lives in `src/lib/time.ts` as `nextDayDate(day, offsetSec, nowSec)` with an injectable clock. The existing UTC-date injection in weatherAgent instructions stays as the model's only floor for count-style phrasings ("in 3 days").
- **Out of scope:** hourly forecast granularity, DST-crossing ±1h entry bucketing (twice yearly per zone; OpenWeather returns one frozen offset), One Call 3.0, any location memory.

## Stage 1: deterministic date math in the lib

**Files:** `src/lib/time.ts` (+`nextDayDate(day, offsetSec, nowSec = now)`), `src/lib/__tests__/time.test.ts` (+3 cases).

**Cases pinned:** same-day inclusive, month rollover (Dec 30 2024 + Saturday → Jan 4 2025), UTC/local date mismatch (Wednesday 23:30 UTC at UTC−5 is Wednesday locally → 'thursday' resolves to the next local day, not UTC+1). No callers yet; pure addition.

**Verify:** `bun test src/lib/__tests__` green, `bun run --bun tsc --noEmit` clean.

**Commit:** `feat: add nextDayDate for zone-aware relative days`

## Stage 2: forecastTool takes a day name

**File:** `src/mastra/tools/weather-tool.ts` only. Input gains optional `day` enum; `date` stays optional; `getForecast(location, { date, day }, signal)` requires exactly one before any fetch. Resolution runs through Stage 1's helper against the forecast response's own `city.timezone`. Agents untouched — existing date-only callers keep working.

**Verify:** `bun test`; on the dev server :4111 execute `forecast-tool {"location":"Brookfield","day":"saturday"}` and confirm the resolved date + day summary come back.

**Commit:** `feat: accept day-name input on forecastTool`

## Stage 3: agent instructions assign the checks

**Files:** `src/mastra/agents/weather-agent.ts` (check-for-location bullet; forecast bullet prefers `day` for day names, `date` for absolutes, checks the operator when phrasing is materially ambiguous), `src/mastra/agents/jamis.ts` (one delegation line covers current + forecast weather; the current-weather location-screening bullet is deleted). Per the ADR consequence note: touch both files or neither.

**Verify:** tests + typecheck; live smokes on :4111 through jamis — the zoo-Saturday question answers directly via the day path, no date interrogation; a bare "what's the weather?" gets a plain-text check for the place instead of a guess; on a Saturday itself, "Saturday" returns today's remaining hours.

**Commit:** `feat: weather checks live inside weatherAgent`

## Gate: repo-wide

`bun test` (suite plus new cases), `bun run --bun tsc --noEmit`, and one final jamis smoke per stage-3 verify list.

## Stage 4: review-hardening (post-plan findings)

**File:** `src/mastra/tools/weather-tool.ts`, `src/lib/fetch.ts`, `src/mastra/agents/weather-agent.ts`.

- `visibilityMiles` optional: omitted by some stations; NaN would fail output validation
- mixed precipitation sums rain + snow instead of dropping one
- `data.city.timezone` validated before use
- `date` input rejected when not a real calendar date
- model-facing errors name a class only (auth failed / rate-limited / unreachable / failed); status, host, and location detail go to server logs — provider internals stay out of iMessage

**Verify:** tests + typecheck; live smokes for not-found, invalid date, and a normal two-tool flow.

**Commit:** one hardening commit, reviewed findings verbatim.

## Evidence debugging wrong behavior

If Jamis asks for the date ("What date is it for you today?"), the model ignored the injected UTC line — tighten the instruction, do not add state. If it returns a day-shifted answer for a far-zone place, the destination-zone filter disagreed with the model's arithmetic — more cases for `day`, not more prompting.
