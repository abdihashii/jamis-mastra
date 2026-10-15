# Context Map

## Contexts

- [Jamis](docs/CONTEXT.md): the operator's personal agent system and its infrastructure.
- [Fantasy Companion](src/fantasy/CONTEXT.md): the passive Sleeper league companion and its weekly editorial recap.

## Relationships

- **Fantasy Companion to Jamis channel:** both use the same Sendblue line and webhook. The configured Fantasy group is routed to passive persistence and never invokes Jamis.
- **Fantasy Companion to Operator:** fixed failure and recovery notifications use Jamis's direct-message path. Jamis does not compose the Fantasy weekly recap.
- **Shared infrastructure:** both contexts use the existing Postgres storage and ClickHouse observability boundaries.

## Accepted next architecture (not implemented)

[ADR 0023](docs/adrs/0023-fantasy-pundit-editorial-workflow.md) and [plan 032](docs/plans/032-fantasy-pundit-editorial-workflow.md) define the Fantasy Football Pundit Domain specialist, Alexandria NFL research, deterministic and editorial validation, and the Broadcaster Capability specialist. The recap workflow composes these boundaries; existing passive ingress and durable delivery authority remain intact. Supporting `src/fantasy` code will move to `src/lib/fantasy` during implementation, not as part of these documentation changes.
