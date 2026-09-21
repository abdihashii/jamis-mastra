# Triage application incidents from owned evidence

Jamis triages an Application incident from the evidence that already owns each fact: ClickHouse observability for execution evidence, and existing application-owned Postgres records for durable outcomes. Safe explicit correlation identifiers connect those sources; timestamp proximity never establishes identity, and JAM-65 does not add a general incident database.

ADR 0021 extends this owned-evidence rule across the full Deployment and partially supersedes target selection: Monitoring now owns broad discovery, while Incident triage accepts one trusted target.

Triage identifies, scopes, and classifies the incident and its supporting evidence. It reports a cause only when the correlated evidence proves one; broader root-cause investigation and remediation remain separate work.

## Why

A new incident ledger would copy agent, workflow, channel, storage, and domain outcomes into a second source of truth. Every application path would then need to write both its real outcome and the incident copy correctly, including while storage or observability is failing. Existing evidence already carries the required facts once exact correlation is added at the owning boundary.

## Consequences

- Each supported top-level execution needs a safe exact correlation value or an exact trace reference in its existing durable record.
- Application-owned durable state remains authoritative when it exists; traces provide supporting execution evidence.
- Missing, conflicting, or unavailable evidence is reported without reconstruction or guessing. Ambiguous evidence returns at most five allowlisted candidates identified only by component, UTC time, stage, and human domain reference so the operator can clarify safely.
- The shipped JAM-65 reader can discover bounded application candidates, but future operator routing sends broad discovery to Monitoring. Incident triage receives one preceding request, unambiguous finding, named component, or exact domain reference.
- Raw identifiers, payloads, errors, prompts, responses, and trace bodies do not enter the triage result.
- Full-Deployment evidence and composition follow ADR 0021 through JAM-67, JAM-68, and JAM-69.

## Alternatives not taken

- **General incident database.** Rejected because it duplicates multiple existing authorities and adds a new write path that can fail during the incident it is meant to explain.
- **Timestamp correlation.** Rejected because concurrent executions can overlap and produce false attribution.
