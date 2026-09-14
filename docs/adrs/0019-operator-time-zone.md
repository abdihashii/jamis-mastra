# Operator time zone is explicit deterministic state

Jamis keeps runtime clocks and stored instants in UTC, but interprets unqualified civil dates and presents timed results in the effective **operator time zone**. The deployment default is a required, validated IANA value in `OPERATOR_TIMEZONE`; a confirmed Postgres override wins until it is changed or reset. This state represents the operator's declared civil time zone, not physical location. A place phrase may seed a proposed zone, but the stored zone never serves as evidence of live location.

## Decision

- Calendar and Gmail day boundaries use the operator time zone. Timed results retain a UTC instant and receive an operator-local presentation. Calendar all-day values remain date-only and are never converted through midnight.
- Weather relative dates use the operator time zone, superseding that part of [ADR 0016](0016-weather-location-and-timing-via-checks.md). Weather location remains explicit, while destination-local clock values remain destination-local and carry an offset or zone label.
- Fantasy recap scheduling keeps its independent league time zone and never follows an operator override.
- Jamis reads the effective time through deterministic application code. Observational Memory is not authoritative time-zone state, and there is no separate time-zone HTTP service.
- A conversational change uses the first write boundary anticipated by [ADR 0012](0012-jamis-hitl-as-text-checks.md): one narrow time-zone mutation, validated and restricted to the operator's Sendblue DM. Jamis shows the proposed IANA value; only an explicit confirmation in the immediately following operator message may apply it. Any other next message cancels the proposal. Reset follows the same confirmation rule.
- Deployment validates `OPERATOR_TIMEZONE` before replacing the running app and exits nonzero with a clear terminal error when it is absent or invalid. Boot validation remains a secondary guard. General off-box uptime alerting is a separate concern.

## Why

An ambient process `TZ`, model memory, or destination-specific rules can each produce plausible but inconsistent calendar and email dates. One explicit default plus one durable override makes the effective zone inspectable and stable across hosts, runs, and restarts. The narrow confirmed write keeps chat convenient without exposing a generic database mutation surface.
