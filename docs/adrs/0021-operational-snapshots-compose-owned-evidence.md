# Operational snapshots compose owned evidence

Jamis exposes two on-demand, read-only operational capabilities across the full Deployment: Monitoring discovers and reports service outcomes and known findings, while Incident triage scopes and classifies one selected incident. The existing `checkMonitoring` and `triageIncident` tools remain the two deep operator-facing modules; source-specific readers stay behind them and preserve the vocabulary, time boundary, and authority of each source.

## Why

The operator needs a concise iMessage account of what happened and what remains unknown, then intervenes directly on the box when warranted. A generic status schema would flatten durable outcomes, execution status, component state, and missing evidence into misleading labels. A central operations database would duplicate ClickHouse observability, Postgres domain state, host state, and service state while adding collection, synchronization, retention, and failure modes.

## Consequences

- Monitoring leads with the real service outcomes: operator requests and reply delivery, plus Fantasy recap delivery. Component findings, recovered recent events, operating-normal evidence, and unknowns remain distinct. There is no Deployment-wide status rollup.
- Durable domain state owns product correctness when it exists. Channel delivery owns delivery evidence. Mastra execution outcomes apply only where no stronger product authority exists. Child span errors, logs, duration, token, and other metrics are supporting evidence, not automatic product failures.
- Evidence remains federated in its authoritative source. A fixed allowlisted Deployment inventory is assessed through source-owned, bounded, read-only checks. New collection is added only for evidence that cannot otherwise be queried safely or retained long enough.
- Missing or stale evidence makes only the affected component unknown. Direct categorical evidence may create a finding; V1 does not invent generic numeric thresholds or anomaly detection.
- External providers appear only when application-owned evidence proves impact. Monitoring does not poll provider status pages or run synthetic product transactions.
- Monitoring discovers findings. Incident triage accepts a trusted target from the preceding request, one unambiguous snapshot finding, a named component, or an exact domain reference. Broad discovery belongs to Monitoring.
- Triage may show nearby evidence only as explicitly uncorrelated context. It reports a cause only when existing exact evidence proves one; investigation, remediation, proactive alerting, and automated action remain separate future work.
- iMessage receives only allowlisted classifications, UTC timestamps, bounded counts, evidence gaps, and safe references. Raw logs, traces, errors, payloads, prompts, responses, personal content, identifiers, and arbitrary metadata remain on the box.

## Alternatives not taken

- **One shared status schema.** Rejected because the apparent simplicity moves source-specific semantics into adapters and obscures the facts the operator needs.
- **One central evidence or incident store.** Rejected because it copies existing authorities and can fail during the incident it is meant to explain.
- **One tool per source.** Rejected because it leaks topology into Jamis routing and expands the model-facing tool surface.
- **Dynamic component discovery.** Rejected for V1 because the Deployment inventory changes through reviewed Compose and Mastra registration edits.
- **Proactive monitoring and automated investigation.** Deferred until repeated operational evidence justifies the extra machinery.
