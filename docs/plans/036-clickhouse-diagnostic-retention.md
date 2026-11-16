# 036: ClickHouse diagnostic retention

Status (2026-11-16 UTC): Final three-day/seven-day policy validated locally; repository gate and independent review passed. Commit approved by the Operator. Operator confirmed production version and completed the separately approved two-table diagnostic cleanup. Retention deployment and push remain unapproved. Keep this work separate from watchdog PR #61.

## 1. Validate the proposed configuration

**Goal:** Prove seven-day diagnostic TTLs (preserving three days for asynchronous
inserts) and warning-level text logging against disposable ClickHouse matching the repository pin (26.7.3.19),
including existing and newly created tables. Confirm the running production
version before any production recommendation is applied.

**Critical files:** `clickhouse/log-retention.xml`, its mount in
`docker-compose.prod.yml`, and this validation record. Apply the agreed three-day asynchronous-insert policy and verify the final XML. Do not touch application trace tables, credentials,
production volumes, or the watchdog implementation.

**Verification:** Isolated container with no published ports or production mounts;
record version, effective configuration, active diagnostic table DDL, existing
row retention/renames after configuration change, restart stability, and actual
TTL expiry on disposable old/new rows. Inspect all proposed log sections and
warning-level text output. Record limitations and cleanup all test resources.

**Acceptance:** Concrete SQL observations demonstrate which tables acquire TTL,
what happens to pre-existing tables/data, and whether old versus recent rows
expire as intended. Compose overlay must render with the expected read-only mount
using only synthetic environment values. No claim that adding XML immediately
reclaims historical disk space.

**Proposed commit:** `fix: bound ClickHouse diagnostic log retention`

## 2. Separate review and production gate

Review final config and validation evidence before requesting a separate commit
and PR. Deployment needs explicit authorization and an up-to-date read-only
production inventory (version, disk headroom, active/archived diagnostic tables).
Any historical cleanup requires its own scoped approval. Verify retention before
production watchdog enablement; the watchdog only reports symptoms.

## Evidence

- Local image: `clickhouse/clickhouse-server:26.7.3.19` (arm64), image/digest
  `sha256:f90a77560f72b10802106ee49e9870e41668cbc496e280c3911f6e3b216657f3`.
- Agent SSH to the VPS timed out. Operator subsequently confirmed container
  `jamis-clickhouse-1`, image `clickhouse/clickhouse-server:26.7.3.19`, and the
  matching installed binary version from the VPS.
- Upstream [issue #93778](https://github.com/ClickHouse/ClickHouse/issues/93778)
  describes renaming existing system log tables with a numeric suffix when TTL
  or engine configuration changes. Verify behavior on the pinned version locally;
  do not assume the new TTL reaches renamed historical tables.

## Initial proposal validation (2026-11-16 UTC)

Both fixtures ran `SELECT version(), serverTimeZone()` and reported
`26.7.3.19`, `UTC`. Containers had `--network none`, no published ports, separate
named disposable volumes, and the existing production `memory.xml` cap. The
proposal XML and Compose overlay were tested unchanged. No real credentials or
production mounts were used.

| Check | Observed result |
| --- | --- |
| Existing volume, initially without proposal | 22 MergeTree diagnostic tables; text logging defaulted to `trace`. A historical text row dated 2000-01-01 and an application-table sentinel were seeded. |
| Apply proposal to existing volume | All 12 target tables acquired `TTL event_date + toIntervalDay(7)`. All 12 originals were renamed to `*_log_0`, retaining their old TTL or lack of TTL. Total diagnostic tables: 34. |
| Historical data | The seeded old row remained in `system.text_log_0`, which still had no TTL. The application sentinel was unchanged. Both survived restart. |
| Fresh volume with proposal | All 12 target tables had seven-day TTLs from creation. No archived `_0` tables; 22 diagnostic tables total. |
| Warning text logging | Effective merged `text_log.level` was `warning`; observed generated text rows were only `Error` and `Warning`. This affects the system table, not the separate server file logger. |
| Expiry, all 12 targets | With TTL merges paused, each table received one old (2000-01-01) and one current-day row. Before processing: 1 old/1 recent in every table. Resume plus synchronous `MATERIALIZE TTL`: 0 old/1 recent in every table. This proves expiry semantics, not background scheduling latency. |
| Identical-config restart | Table names and UUIDs unchanged: 34/34 on existing volume, 22/22 on fresh volume. No second rollover. |
| Compose | Rendered with synthetic variables and `--no-env-resolution`; exact pinned image, retention bind mount read-only, no published ClickHouse ports. Real `.env.prod` was not loaded. |

Reproduction SQL (only on disposable diagnostic tables):

```sql
SYSTEM STOP TTL MERGES;
INSERT INTO system.text_log (event_date, event_time)
VALUES ('2000-01-01', '2000-01-01 00:00:00');
INSERT INTO system.text_log (event_date, event_time)
SELECT toDate(now('UTC')), toStartOfDay(now('UTC'));
SELECT countIf(event_date = toDate('2000-01-01')) AS old_rows,
       countIf(event_time = toStartOfDay(now('UTC'))) AS recent_rows
FROM system.text_log;
SYSTEM START TTL MERGES;
ALTER TABLE system.text_log MATERIALIZE TTL SETTINGS mutations_sync = 1;
-- Repeat the SELECT: old_rows = 0, recent_rows = 1.
```

The same assertions were executed for each XML section, not just text_log.
Baseline/after/restart snapshots and generated SQL are saved locally under
`/private/tmp/jamis-retention-validation/`. These fixtures contained only synthetic
and locally generated data. Both containers and both named volumes were removed
after validation. Repository whitespace checks passed; the application suite was
not rerun because this step changed only this validation record, not application
code or the proposed configuration.

### Policy and rollout implications

- The XML has **12** log sections. It does not cover every diagnostic table;
  other default-enabled logs such as `query_thread_log`, `backup_log`,
  `opentelemetry_span_log`, and storage-specific logs are outside this proposal.
- The final policy preserves `asynchronous_insert_log` at its existing
  **three-day** TTL, as accepted by the Operator. The initial all-seven-day
  proposal above was changed only for that table. `processors_profile_log`
  goes from 30 days to seven days.
- `event_date` is day-granularity retention, not exactly 168 elapsed hours per
  row. Deletion occurs during TTL processing. The tested default
  `merge_with_ttl_timeout` is 14,400 seconds (minimum interval for repeated TTL
  delete merges), not a guaranteed maximum reclamation delay.
- Archived originals retain their old policies. Adding this XML does **not**
  reclaim the historical backlog. Do not automatically drop/truncate these tables.
  Inventory their sizes and retention requirements on production first; obtain
  separate approval for any historical cleanup.
- Seven days bounds age, not bytes. Check current production disk headroom and
  growth rate before rollout. Leave the watchdog enablement gate separate.
- Production version and disk headroom were confirmed by the Operator below.
  Production architecture was not inspected. No retention configuration has
  been deployed; the only production deletion was the separately approved
  diagnostic cleanup recorded below.

## Operator production checks and approved cleanup

The Operator reported root filesystem usage of 96% (38 GB total, 1.7 GB free).
Docker reported no meaningful reclaimable space; `jamis_chdata` held 22.9 GB.
A read-only `system.parts` inventory identified `system.trace_log` at 7.60 GiB
and `system.text_log` at 7.18 GiB. The next largest diagnostic tables were
`metric_log` (1.81 GiB), `part_log` (1.75 GiB), `processors_profile_log` (1.45 GiB),
and `asynchronous_metric_log` (976.34 MiB). These remain outside the approved
cleanup and retain historical rows until separately addressed.

Official [trace_log](https://clickhouse.com/docs/reference/system-tables/trace_log)
and [text_log](https://clickhouse.com/docs/reference/system-tables/text_log)
documentation states for each: "It is safe to truncate or drop this table at any
time." [TRUNCATE](https://clickhouse.com/docs/reference/statements/truncate)
removes data while preserving table structure. The Operator explicitly approved
clearing just those two diagnostic tables after reviewing this guidance.

The Operator executed each truncation separately and reported success:

1. `TRUNCATE TABLE system.trace_log`: no output; root usage fell to 75%, 9.2 GB free.
2. `TRUNCATE TABLE system.text_log`: no output; root usage fell to 55%, 17 GB free.

No `default.mastra_*` table was targeted. This permanently removed those two
ClickHouse diagnostic histories; it did not install retention or disable logging.
No further production cleanup is authorized by this record.

**Next:** Verify the final three-day/seven-day configuration, review it, then
request a separate retention commit. Push and deployment require their own
approval. Do not include these changes in watchdog PR #61.


## Final policy verification (2026-11-16 UTC)

The configuration now explicitly preserves `asynchronous_insert_log` at three
days and sets the other 11 listed logs to seven days. A separate branch,
`fix/clickhouse-diagnostic-retention`, was created from `origin/main`; no watchdog
commits are included.

Two fresh isolated fixtures repeated the configuration/migration checks on
26.7.3.19 with the final XML:

- Existing default three-day asynchronous-insert table retained its UUID, with
  no `asynchronous_insert_log_0` created. The other 11 originals were archived;
  historical text rows and the application sentinel survived.
- Fresh-volume DDL and merged XML matched all 12 intended TTLs; generated text
  logging stayed at warning or more severe levels.
- Each target table received an eight-day-old, five-day-old, and current row.
  Explicit TTL processing removed eight-day rows from all 12, retained current
  rows in all 12, and removed five-day rows **only** from asynchronous inserts.
- Restarting either fixture preserved table names, UUIDs, TTLs, and archive counts
  (33 on existing volume, 22 on fresh volume). No repeated rollover.
- Synthetic Compose rendering confirmed the read-only mount and absence of
  published database ports, without reading real application environment files.

A test-harness query initially used unsupported `today('UTC')`; it was corrected
to `toDate(now('UTC'))` before the expiry phase. The resumed assertions all passed.
No configuration change was needed for that harness error. Final artifacts and
assert-based verification script: `/private/tmp/jamis-retention-final/`.

**Final gate:** 1,481 Bun tests passed, one existing Linux-only mount test skipped,
zero failures; all four Python tests on this branch passed; typecheck, lint,
build, and whitespace checks passed. Integration tests used disposable loopback
PostgreSQL and fake credentials with dotenv loading disabled. This branch is based
on main and does not include the additional watchdog tests from PR #61.

**Review-code:** Four fresh read-only passes covered configuration correctness,
tests/contracts, data integrity, and deployment integration. No verified findings.

**Cleanup:** Both final ClickHouse containers and their named volumes were removed;
the disposable PostgreSQL container and its test volume were also removed.
No unrelated container or volume was changed.

**Commit gate:** Operator approved
`fix: bound ClickHouse diagnostic log retention`. Only the XML, its Compose mount,
and this plan belong in that commit. Push/PR and production TTL deployment remain
separate approval gates.
