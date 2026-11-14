# 035: Host watchdog

Status (2026-11-14 UTC): Stages 1 and 2 implemented, verified, committed, and pushed to `feat/host-watchdog-stage-1` in [PR #61](https://github.com/abdihashii/jamis-mastra/pull/61). Stage 1 is installed on the VPS and its real test DM was received. Stage 2 is verified locally but not deployed. Stage 3 has not started; no watchdog timer is enabled. Implementation, commits, pushes, and the Stage 1 host smoke were separately authorized in conversation; this document grants no additional deployment or message authorization.

## Goal and scope

Warn the Operator before the existing VPS root filesystem fills, or after the app cannot complete a PostgreSQL readiness query. Send failure and recovery DMs directly through Sendblue from the host, without depending on Jamis, Docker, PostgreSQL, ClickHouse, or an LLM to send them.

The November 11 incident exhausted the approximately 38 GB root filesystem, leaving about 36 MB free. ClickHouse diagnostic logs occupied roughly 20 GB, PostgreSQL reported `PANIC: No space left on device`, and the scheduler ran 8 hours 37 minutes late. Removing unused build cache recovered about 2.6 GB. Alerting does not correct that retention problem. Preserve the separately prepared, unapproved `clickhouse/log-retention.xml` and Compose mount; do not include them in watchdog commits.

This introduces notification transport, an app readiness contract, and host scheduling/state. Deliver three independently committable slices. Prove the highest-risk dependency first: a real host-to-Sendblue DM before readiness or periodic checks depend on it.

## Fixed design

- One Python standard-library script on the existing VPS, plus a systemd oneshot and timer. No package dependency, additional container, paid monitoring service, agent workflow, or automatic remediation.
- Every 60 seconds, inspect `/` with `os.statvfs` and request `http://127.0.0.1:4111/readyz`. The existing production Compose binding already exposes the app on host loopback. Do not use the host evidence socket, Docker inspection, the deployment-monitoring tool, or public tunnel for these checks.
- Disk: alert immediately at **85% or more**, recover only **below 80%**. Use unrounded `used / (used + available-to-unprivileged-processes)` from filesystem blocks, matching operational `df` semantics; report rounded usage and available bytes. Confirm Docker data and database volumes reside on this filesystem during installation.
- App/PostgreSQL: alert after **three consecutive failed checks**, recover after **two consecutive successes**. A success requires HTTP 200 and the expected small readiness response. Reset the opposite streak each time; timeouts, malformed responses, auth errors, and non-200 responses are failures. A failed disk read is unavailable evidence, never recovery.
- Add authenticated `GET /readyz`, returning only `{"status":"ready"}` or HTTP 503 with `{"status":"unavailable"}`. Each request must execute `SELECT 1` against the app's configured PostgreSQL writer. Reuse the existing `PostgresStore` instance, retaining its current storage configuration. No cached success, model call, tracing query, database write, or dependency on Fantasy tables.
- Bound database checkout/query and release or destroy timed-out resources. Do not implement a response-only `Promise.race` that leaves new queries accumulating. Verify the installed pool API before choosing the smallest cancellation mechanism; do not change unrelated application query timeouts. The host readiness request has a **5-second total deadline**.
- Mastra custom routes cannot use its reserved `/api` prefix. Explicitly protect `/readyz` through the existing `SimpleAuth`, preserving `/api/*` protection and existing exceptions. The host uses the existing `API_TOKEN`. Test actual middleware enforcement, not only the route handler. Loopback is the probe's address, not a claim that the route cannot also be reached through the existing authenticated proxies.
- Direct HTTPS POST to `https://api.sendblue.co/api/send-message`, using the existing `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`, and `JAMIS_ALLOWED_NUMBER`. Send one bounded plain-text DM containing the affected checks, observed facts, incident time, and UTC observation time. Do not expose phone numbers, tokens, connection strings, or raw provider/database errors in logs or messages.
- Keep those five values in `/etc/jamis/watchdog.env`, root-owned mode `0600`, outside the repository and container mounts. Supply a names-only example. The unit reads this file directly; no dependency on sourcing the app's environment or retrieving secrets from a running container. Document rotating its copied credentials alongside the app's credentials.
- Use a **15-second total Sendblue deadline**, including response consumption, a bounded response body, TLS verification, and no automatic HTTP retries or redirects. Socket inactivity timeouts alone do not establish the total deadline. At most one POST per invocation, combining eligible check transitions.
- Timer: `OnBootSec=60s`, `OnUnitActiveSec=60s`, `AccuracySec=1s`. Service: `Type=oneshot`, explicit `TimeoutStartSec=45s` and `TimeoutStopSec=5s`; no `RemainAfterExit` or Docker/app unit dependency. Use the existing host-hardening pattern and allow writes only to its state directory. A small host lock also prevents a manual invocation racing the timer.

## Notification and state rules

Persist one small, versioned JSON state file under `/var/lib/jamis-watchdog`, root-only, with current conditions, streaks, incident timestamps, notification outcome, and next retry time. Keep no event history or database. Write a same-directory temporary file, flush/fsync it, then atomically replace the previous state. Bound and validate reads. Normal healthy startup sends nothing; restarts retain streaks and cooldowns.

| Provider result | Meaning | Next action |
| --- | --- | --- |
| Valid handle, status `QUEUED`, `SENT`, or `DELIVERED`, and no provider error | Accepted by Sendblue | Record acceptance; no repeated alert while that condition remains active. Acceptance is not a claim of handset receipt. |
| Explicit rejection, including HTTP 4xx or a recognized `ERROR` response even with HTTP 200 | Rejected | Retry the still-relevant notification after 5 minutes; one attempt per invocation. |
| Timeout, connection loss, HTTP 5xx, malformed/contradictory response, or interruption after recording send intent | Acceptance unknown | Wait 30 minutes before retrying the still-current alert. Label that retry as a possible repeat of an earlier notification. |

Record send intent durably before making the POST. An interrupted intent is unknown on the next run, including a crash after provider acceptance but before saving its response. The POST has no verified idempotency guarantee, so a later retry can duplicate a DM. Do not call that exactly-once delivery.

Keep only the latest relevant notification per check, not a backlog. When a condition recovers, cancel obsolete alert retries. Send recovery if its alert was accepted or might have been accepted; a never-accepted, explicitly rejected alert needs no recovery DM. A new recovery can be sent immediately, independently of its former alert's retry delay. Apply the same outcome handling to recovery sends, and supersede stale recovery retries if a fresh incident starts. Accepted messages produce no periodic reminders. If both checks change together, combine their notices.

Preserve the previous file and exit with a bounded, sanitized journal error if state cannot be read safely or atomically saved. Do not silently reset notification state. State-storage failure, including a completely full disk, can suppress notifications; the 85% threshold is intended to act before that point. No extra fallback state mechanism in this change.

## 1. Prove standalone host notification

**Status:** Complete. Commit `d7b9f0a` (`feat: add standalone host watchdog notification`).

**Verification recorded:** Full gate passed: 1,481 Bun tests passed, one existing Linux-only mount test skipped, zero failures; 10 Python tests passed; typecheck, lint, build, and whitespace checks passed. Python coverage includes provider outcomes, oversized/malformed responses, stalled headers, trickling bodies, no retries, and sanitized output. The successful Bun run used isolated fake credentials, dotenv loading disabled, and disposable PostgreSQL; an initial environment-contaminated run was stopped and is not counted as passing. No independent review-code pass was recorded for Stage 1.

**Host smoke recorded (2026-11-14 UTC):** Operator installed `/usr/local/libexec/jamis-watchdog`, created `/etc/jamis/watchdog.env`, and confirmed `root root 600`. The one-shot systemd smoke reported `accepted`, exit 0, and 611 ms runtime. Operator confirmed receipt of the labeled DM with observation time `2026-11-14T20:46:20Z`. This proves host-to-Sendblue delivery for that test, independently of app/database execution. No timer was installed or enabled.

**Goal:** Install the smallest direct sender and prove that the existing credentials, sender, and Operator recipient work from host Python without importing or calling the application.

**Critical files:** new `infra/host_watchdog.py`, `infra/test_host_watchdog.py`, `infra/watchdog.env.example`, and `docs/setup-host-watchdog.md`.

**Work:** Add the bounded Sendblue sender, strict accepted/rejected/unknown classification, and one explicit `--test-notification` mode that sends a clearly labeled test DM. Document root-only installation and credential entry. No scheduled execution yet. Follow the existing `infra/test_host_evidence_probe.py` standard-library test style.

**Verify:** Mock accepted, HTTP-200 `ERROR`, 4xx, 5xx, malformed/oversized body, stalled response, and timeout outcomes. Assert no implicit retries and no secret-bearing output. Run the repository gate below.

**Demo:** After explicit authorization for the external test message and host installation, run on the VPS:

```sh
rtk sudo systemd-run --wait --pipe --collect --unit=jamis-watchdog-smoke --property=EnvironmentFile=/etc/jamis/watchdog.env /usr/bin/python3 /usr/local/libexec/jamis-watchdog --test-notification
```

Observe a sanitized accepted result and the Operator's receipt of the labeled DM. This command uses host Python and the root-owned file; it does not call Docker, Mastra, or either database. Do not stop production services merely to demonstrate independence.

**Committed:** `d7b9f0a` `feat: add standalone host watchdog notification`

## 2. Add authenticated PostgreSQL readiness

**Status:** Implementation and local verification complete. Commit `a07f9e1` (`feat: add authenticated PostgreSQL readiness`), pushed to the same PR. Production deployment and authenticated VPS readiness smoke remain pending.

**Implementation recorded:** The existing PostgresStore is named and reused by both composite storage and `/readyz`. The route explicitly preserves SimpleAuth protection for `/api/*` and adds `/readyz`, retaining existing public exceptions. Each success requires fresh `SELECT 1`; responses disable caching and expose only readiness status. A four-second total checkout/query deadline leaves margin inside the host's five-second deadline. Failed or timed-out checked-out clients are destroyed with `release(true)`; application pool settings are unchanged.

**Pool limitation:** Installed pg cannot cancel an individual pending checkout. One readiness operation is allowed at a time, including a checkout that timed out. A late client is destroyed without running SQL; overlapping probes return 503 rather than accumulating waiters. If checkout never settles, readiness remains unavailable until settlement or app restart. This limit is documented in the implementation and setup guide.

**Verification recorded:** Full gate passed with isolated fake credentials and disposable PostgreSQL: 1,486 Bun tests passed, one existing Linux-only mount test skipped, zero failures; 10 Python tests passed; typecheck, lint, build, and whitespace checks passed. Five native readiness tests cover actual Mastra HTTP authentication, writer queries, refused connections, saturated/late checkout, SQL failure, stalled response disposal, and recovery. Four independent read-only review-code passes (correctness/concurrency, tests/contracts, security, integration) returned no verified findings.

**Local smoke recorded (2026-11-14 UTC):** Agent and Operator each exercised an isolated Mastra HTTP app using the production readiness configuration and disposable PostgreSQL. Operator confirmed `401` without credentials, `200/ready` with a fake token, `503/unavailable` in 0.002226 seconds after stopping only the disposable database, and `200/ready` after restarting it without restarting the app. The local HTTP listener was `127.0.0.1:14111`; PostgreSQL used loopback port 15458 and database `jamis_sessions_test`. Temporary app/test containers and test volumes were cleaned up. Production PostgreSQL was untouched.

**Goal:** Prove that an app HTTP success means PostgreSQL actually answered a bounded query.

**Critical files:** `src/mastra/index.ts`, new `src/mastra/readiness.ts` and adjacent `src/mastra/readiness.test.ts`; extend `docs/setup-host-watchdog.md` with the endpoint contract and smoke.

**Work:** Name and reuse the current `PostgresStore`, register `/readyz`, protect it explicitly, and implement the minimal query/response contract above. Keep private types in the owning implementation. Do not alter Sendblue routing, agent tools, storage schemas, or the existing host-evidence API.

**Verify:** Missing and incorrect bearer tokens are rejected before SQL runs; a valid token with a real successful SQL query returns ready; refused connection, saturated checkout, query failure, and stalled query return unavailable within the bound without accumulating connections. No raw error escapes. Run the repository gate.

**Demo:** Start a disposable local app/database stack. Request `/readyz` without auth, then with valid auth using a protected curl config file, for example `rtk curl --max-time 5 --config /private/tmp/jamis-watchdog-curl.conf http://127.0.0.1:4111/readyz`. Observe denial then 200/ready. Stop only the disposable PostgreSQL service, observe bounded failure, restore it, and observe 200/ready. Remove the temporary auth file. Repeat the authenticated healthy host-loopback smoke after separately approved deployment.

**Committed:** `a07f9e1` `feat: add authenticated PostgreSQL readiness`

## 3. Enable host checks and persistent alert transitions

**Status:** Pending. Next implementation stage; no checks, persisted alert state, service/timer, or deployment integration have been added. Complete isolated verification and review-code, obtain commit approval, and obtain separate push/deployment approval. Verify authenticated readiness on the VPS after deployment and before enabling periodic checks. The separate retention proposal remains uncommitted and unapplied.

**Goal:** Deliver disk and readiness failure/recovery DMs from the existing VPS with bounded retries across process restarts.

**Critical files:** `infra/host_watchdog.py`, `infra/test_host_watchdog.py`, new `infra/jamis-watchdog.service` and `infra/jamis-watchdog.timer`, `infra/deploy.sh`, and `docs/setup-host-watchdog.md`.

**Work:** Add filesystem/readiness checks, hysteresis and streaks, the small atomic state file and lock, transition messages, and retry rules. Install the script and units from the existing deployment path. Validate the root-protected configuration before enabling the timer; document first installation, status inspection, credential rotation, and rollback with `systemctl disable --now jamis-watchdog.timer`. Keep retention edits out of this diff.

**Verify:** Python tests exercise exact 85/80 boundaries; failure and recovery streaks; flapping; simultaneous incidents; accepted silence; rejected/unknown retry delays; recovery superseding an unsent alert; a new incident superseding recovery; restart preservation; interrupted send intent; corrupt/unwritable state; atomic replacement failure; overlapping runs; and hung HTTP termination. Use temporary directories, a fake clock, and a local stub server, without real sends. Run the repository gate and `rtk systemd-analyze verify infra/jamis-watchdog.service infra/jamis-watchdog.timer` on Linux with installed paths available.

**Demo:** First exercise the installed timer against an isolated local readiness/Sendblue stub harness and temporary state, with no production threshold changes. Observe one alert after three failures, one recovery after two successes, disk hysteresis, retry cooldown surviving a new process, and an interrupted request ending within the service timeout. Then, after deployment and message authorization, observe `rtk sudo systemctl list-timers jamis-watchdog.timer`, `rtk sudo journalctl -u jamis-watchdog.service -n 20 --no-pager`, and a root-only state file showing two healthy observations. Use the Stage 1 labeled DM for the real transport proof. Do not fill the production disk or stop production PostgreSQL to test alerts.

**Proposed commit:** `feat: schedule persistent host watchdog alerts`

## Verification and approval discipline

After each stage, run the full existing single-package gate, not only focused tests:

```sh
rtk bun run typecheck
rtk bun test
rtk python3 -m unittest discover -s infra -p 'test_*.py'
rtk bun run lint
rtk bun run build
rtk git diff --check
```

Use the repository's existing local database setup for integration tests. Complete one stage, report checks, diff summary, and proposed commit message, then wait for explicit approval before committing. Push and deployment need their own approval. When the Operator enters credentials or runs a smoke, guide one command at a time and wait for its result. Finish with the full repository gate, totals, final commit list, timer status, and verified notification outcome.

No unresolved product decision blocks Stage 3. Stage 1 established host credential/transport viability; Stage 2 verified bounded readiness behavior and documented the uncancellable-checkout limit. Production readiness and timer verification remain deployment gates.

## Evidence and limits

- [Google SRE: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) supports simple actionable symptom/saturation alerts. It does not prescribe the chosen 85/80 thresholds or check cadence; those are this deployment's policy.
- [systemd.timer](https://manpages.debian.org/testing/systemd/systemd.timer.5.en.html): an active service is not restarted by another timer firing; `AccuracySec` defaults to one minute, so set it explicitly.
- [systemd.service](https://manpages.debian.org/bookworm/systemd/systemd.service.5.en.html): oneshot startup timeout is disabled by default, requiring an explicit `TimeoutStartSec`.
- [Sendblue send-message contract](https://docs.sendblue.com/api/resources/messages/methods/send): inspect response status/error fields and message handle, not just HTTP 200. `QUEUED` is not handset delivery. Match the acceptance checks already in `src/mastra/channels/sendblue.ts`.
- Installed Mastra 1.71.0 route/auth docs, native middleware, and `@mastra/pg` 1.27.1 source/types were checked during Stage 2. Official [Mastra custom route authentication](https://mastra.ai/docs/server/custom-api-routes#authentication) confirms custom routes require authentication when auth is configured; `/readyz` also has explicit path protection. Official [node-postgres pool documentation](https://node-postgres.com/apis/pool#releasing-clients) confirms `release(true)` destroys the checked-out connection. These sources were cross-checked using the Mastra and web-research skills.

This host-local watchdog cannot report total VPS loss, loss of outbound networking, or Sendblue failure through that same channel. Readiness verifies the app-to-PostgreSQL path, not model access, public ingress, scheduler timeliness, full workflow correctness, or database write capacity. No ClickHouse retention fix, provider callback/polling, automatic cleanup/restart, or LLM call per probe is included.
