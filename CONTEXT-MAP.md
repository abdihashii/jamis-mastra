# Context Map

## Contexts

- [Jamis](docs/CONTEXT.md): the operator's personal agent system and its infrastructure.
- [Fantasy Companion](docs/FANTASY-CONTEXT.md): the passive Sleeper league companion and its weekly editorial recap.

## Relationships

- **Fantasy Companion to Jamis channel:** both use the same Sendblue line and webhook. The configured Fantasy group is routed to passive persistence and never invokes Jamis.
- **Fantasy Companion to Operator:** fixed failure and recovery notifications use Jamis's direct-message path. Jamis does not compose the Fantasy weekly recap.
- **Shared infrastructure:** both contexts use the existing Postgres storage and ClickHouse observability boundaries.
