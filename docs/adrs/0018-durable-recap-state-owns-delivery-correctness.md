# Durable recap state owns delivery correctness

A dedicated Postgres record for each Sleeper league and fantasy week is the authority for whether a Fantasy weekly recap may be sent. Mastra's scheduled workflow is only a daily wake-up signal. It does not own retry or completion semantics because its in-process scheduler can miss fires during downtime and leave a run marked `running` after a process crash.

The recap state distinguishes `started`, `failed`, `delivery_unknown`, and `sent`. The final generated text is stored before any outbound request, and the send attempt is recorded before contacting Sendblue. A Sendblue response with a nonempty message handle marks the run `sent` automatically. A definite pre-send failure can retry automatically. Delivery unknown pauses automatic sends until the operator checks the group, then either retries the saved text after confirming it is absent or marks the visible message `sent`. The record stores whether Sendblue or the operator confirmed delivery.

## Why

Blindly retrying an uncertain outbound request can duplicate a successful group post. Treating every transport error as final can silently lose a recap. The durable state and operator resolution path preserve both retryability and duplicate resistance across scheduled runs, manual commands, and process restarts.

## Consequences

- League and week are unique, and concurrent scheduled or manual runs must claim the record atomically.
- A long outage posts only the newest completed fantasy week after recovery.
- The manual recovery command operates against the environment where it is run and never opens an SSH connection.
- Exact once delivery cannot be proven when the provider response is lost, so delivery unknown remains an explicit human decision.
