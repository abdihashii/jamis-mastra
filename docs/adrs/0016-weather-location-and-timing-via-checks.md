# Weather location and timing resolve through checks, never stored state

> Superseded in part by [ADR 0019](0019-operator-time-zone.md): unqualified relative dates now resolve in the operator time zone, not the weather destination's zone. The rule against inferring or storing the operator's physical location remains.

The operator's location is not modeled by the system in any form: no env var, no memory writes, no inference from the channel. A weather request with no usable place gets a plain-text check ([ADR 0012](0012-jamis-hitl-as-text-checks.md)) owned by the weather agent — not jamis — before any tool call. Relative date words (`tomorrow`, `next Saturday`) resolve in code inside `forecastTool`, against the destination's local zone, so the model never does timezone arithmetic it cannot reliably do. The model is only told today's UTC date; anything it cannot resolve unambiguously is checked with the operator rather than guessed.

## Context

Jamis answers weather over iMessage. The channel metadata carries no place and no timezone, and the operator's own location can change at any time. Every earlier candidate for "current location" (an env var, a persisted memory fact, deriving sender locale from the number) adds a fact that goes stale the moment of travel while looking authoritative. The relative-date resolution problem is offset arithmetic: the tool knows the destination's zone offset (the forecast response carries `timezone`), but the model does not know it until the tool answers, so model-side extrapolation from weekday phrasing churns out plausibly wrong dates. Day-of-week date arithmetic with zone shifts is a known LLM failure mode; code with the API's own offset data is not.

## Decision

- No operator-location state exists in code, env, or memory. Unclear or missing place in a weather request → the weather agent checks the operator in plain text, then proceeds.
- `jamis` delegates every weather-shaped request — current conditions or forecasts — to weatherAgent in one rule, and no longer screens for location itself. The screening bullet's removal means the check contract lives in exactly one place; the change additionally routes forecast questions onto the weather path (before this, they routed to the research agent and never reached `forecastTool` over the channel).
- `forecastTool` resolves relative dates itself: input is an optional YYYY-MM-DD `date` or an optional `day` name (exactly one required). A day name resolves to its nearest upcoming occurrence **inclusive of today** in the destination zone: `(targetDow − todayDow + 7) % 7`, computed and unit-tested in `src/lib/time.ts`.
- The weather agent's instructions carry one injected fact — today's UTC date — as a floor for count phrasings ("in 3 days") that are not weekday names. Wording that leaves the operator's intended day materially ambiguous (user traveling across zones, "Saturday" said near midnight) triggers a check first, per the ask-instead-of-guess rule already in the glossary.

## Alternatives not taken

- **Operator timezone in env/config** (`OPERATOR_TZ=Europe/Berlin`): authoritative-feeling, silently stale, requires a config edit per trip.
- **Persisted location in memory**: same staleness with less visibility; requires freshness policy and cross-thread scope work for a single-user system.
- **Front-door checks in jamis**: predates this design, kept the weather agent's output "final-form", but pins every weather ambiguity at the supervisor and — with a forecast tool inside weatherAgent — duplicates the location rule in two instructions.
- **Model-side date arithmetic**: zero new code, maximum wrong-answer surface. "Whatever is deterministic and testable" was the operator's ruling on this branch.
- **`daysAhead` instead of weekday**: kills tomorrow-math but leaves Saturday-math to the model anyway — same failure mode, plus a second date-vocabulary for the model.

## Consequences

- One extra outward question over iMessage when a request lacks a place. That cost is by the operator's own design.
- Changing the check ownership later is instruction-text only — one line in each agent — but would silently double-ask until the old screening rule is also removed. Touch both files or neither.
- The DST caveat stands: OpenWeather returns a single offset frozen at request time, so a 5-day forecast spanning a DST switch can bucket one 3-hour entry on the wrong local date. Accepted, twice yearly per zone, bounded to the boundary day. Fix in the tool, not in more instructions, if it ever bites.
