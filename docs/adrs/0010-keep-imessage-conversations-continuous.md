# Keep iMessage conversations continuous while deferring session rollover

Jamis will keep the existing durable Mastra thread for the operator's iMessage conversation and retain thread-scoped Observational Memory as the context-management baseline. We will not add idle expiry, automatic thread rotation, or temporal-gap markers yet, because natural follow-ups often cross a day boundary and the current system has no deliberate cross-thread continuation or recall path.

## Context

iMessage is a linear direct-message surface, not a set of Slack-style reply threads. Mastra maps the same external channel conversation to an existing internal thread, so each inbound text begins a new run but not a new conversation. Observational Memory limits raw prompt growth and preserves observations, but it does not decide whether an old task should remain active after a pause.

Mastra temporal markers annotate a time gap within the same thread. In the installed version, their only configuration is a boolean and their built-in gap is ten minutes. They are not a session boundary, and that interval is too short to stand in for the proposed 24-hour policy.

## Decision

- Keep one continuous Jamis iMessage conversation per durable channel mapping.
- Retain Observational Memory and leave temporal markers disabled.
- Do not expire, delete, or automatically replace a conversation after idle time.
- Evaluate real conversations before changing the boundary. The evaluation must include a natural next-day follow-up and an unrelated topic after a long pause.

## Alternatives not taken

- **Temporal markers now.** They make elapsed time visible but do not isolate topics. The fixed ten-minute gap is likely to mark ordinary texting pauses.
- **A 24-hour sliding idle window now.** It could reduce stale-topic bleed, but it would also move next-day follow-ups into a fresh thread before Jamis has a deliberate cross-thread continuation path.
- **A new thread for every message.** This discards useful immediate conversation context without creating meaningful sessions.
- **Adopting Honcho now.** Honcho separates durable peers from bounded sessions and could provide a stronger cross-session representation. It is deferred because it does not choose an iMessage idle boundary for us, and a single operator on one channel does not yet justify a second memory system. Reconsider it when Jamis needs a shared durable user model across channels or agents.

## Consequences

- Next-day follow-ups keep their current conversational continuity.
- An unrelated topic can still encounter stale task context, which is an accepted risk until real usage shows it warrants a boundary.
- If that evidence appears, evaluate a 24-hour soft rollover as a separate change. It must retain the old thread and define explicit continuation or recall behavior before creating a new active thread.
- Honcho remains a future memory-architecture option, not a prerequisite for a later soft rollover.
