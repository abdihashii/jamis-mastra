# Context Map

## Contexts

- [Jamis](docs/CONTEXT.md): the operator's personal agent system and its infrastructure.
- [Fantasy Companion](src/lib/fantasy/CONTEXT.md): the passive Sleeper league companion and its weekly editorial recap.

## Relationships

- **Fantasy Companion to Jamis channel:** both use the same Sendblue line and webhook. The configured Fantasy group is routed to passive persistence and never invokes Jamis.
- **Fantasy Companion to Operator:** fixed failure and recovery notifications use Jamis's direct-message path. Jamis does not compose the Fantasy weekly recap.
- **Shared infrastructure:** both contexts use the existing Postgres storage and ClickHouse observability boundaries.

## Implemented editorial composition (rollout remains gated)

[ADR 0023](docs/adrs/0023-fantasy-pundit-editorial-workflow.md) and [plan 032](docs/plans/032-fantasy-pundit-editorial-workflow.md) define the internal Fantasy Football Pundit, bounded Alexandria NFL research, deterministic validation, separate editorial review and checked Broadcaster. `src/lib/fantasy/pipeline.ts` supplies one durable composition for scheduling and trusted local CLI execution. Source evidence, original quote bytes, approved ordered artifacts and delivery/recovery each retain their existing owners; neither model prose nor artifact identity grants publication authority. Supporting code is in `src/lib/fantasy`; no Pundit/editor/Broadcaster root is registered. Historical reports and telemetry identities remain compatible. Stage 6.2 commit/deployment and integrated live acceptance remain gated; the production recap cron stays Operator-paused until separate explicit approval.
