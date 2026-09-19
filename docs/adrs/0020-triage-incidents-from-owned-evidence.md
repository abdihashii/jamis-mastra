# Triage application incidents from owned evidence

Jamis triages an Application incident from the evidence that already owns each fact: ClickHouse observability for execution evidence, and existing application-owned Postgres records for durable outcomes. Safe explicit correlation identifiers connect those sources; timestamp proximity never establishes identity, and JAM-65 does not add a general incident database.

Triage identifies, scopes, and classifies the incident and its supporting evidence. It reports a cause only when the correlated evidence proves one; broader root-cause investigation and remediation remain separate work.

## Why

A new incident ledger would copy agent, workflow, channel, storage, and domain outcomes into a second source of truth. Every application path would then need to write both its real outcome and the incident copy correctly, including while storage or observability is failing. Existing evidence already carries the required facts once exact correlation is added at the owning boundary.

## Consequences

- Each supported top-level execution needs a safe exact correlation value or an exact trace reference in its existing durable record.
- Application-owned durable state remains authoritative when it exists; traces provide supporting execution evidence.
- Missing, conflicting, or unavailable evidence is reported without reconstruction or guessing. Ambiguous evidence returns at most five allowlisted candidates identified only by component, UTC time, stage, and human domain reference so the operator can clarify safely.
- A broad historical error question may discover candidates across application components inside one bounded window. Health, rate, and trend questions remain Monitoring rather than Incident triage.
- Raw identifiers, payloads, errors, prompts, responses, and trace bodies do not enter the triage result.
- Full-Deployment evidence remains separate work in JAM-67, JAM-68, and JAM-69.

## Alternatives not taken

- **General incident database.** Rejected because it duplicates multiple existing authorities and adds a new write path that can fail during the incident it is meant to explain.
- **Timestamp correlation.** Rejected because concurrent executions can overlap and produce false attribution.
