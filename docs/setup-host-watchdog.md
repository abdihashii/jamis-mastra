# Host watchdog setup

Stage 1 provides a standalone test sender; Stage 2 adds app PostgreSQL readiness.
Stage 3 adds persistent host checks and timer units, enabled only after the gates below.
Requires host Python 3 on Linux;
the sender uses SIGALRM in the main thread for a 15-second total HTTPS deadline,
including DNS, TLS, and response consumption. TLS certificate verification remains
on. Each send has no redirects or HTTP retries, and response reads stop at 16 KiB
plus one overflow byte.

## Installation (requires separate approval)

Run from the repository on the VPS after reviewing the script. Do not install or
send a real message until the Operator explicitly approves both actions. When
assisting the Operator, issue one command at a time and verify its result.

```sh
rtk sudo install -d -o root -g root -m 0755 /usr/local/libexec
rtk sudo install -o root -g root -m 0755 infra/host_watchdog.py /usr/local/libexec/jamis-watchdog
rtk sudo install -d -o root -g root -m 0700 /etc/jamis
```

For first installation only, copy the names-only example. Do not overwrite an
existing credential file during upgrades:

```sh
rtk sudo install -o root -g root -m 0600 infra/watchdog.env.example /etc/jamis/watchdog.env
rtk sudoedit /etc/jamis/watchdog.env
```

Enter the existing app's `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`,
`SENDBLUE_FROM_NUMBER`, `JAMIS_ALLOWED_NUMBER`, and `API_TOKEN`. Use systemd
EnvironmentFile syntax (`NAME=value`, no `export`); quote values when needed.
Phone numbers must be E.164, including the leading `+`. `API_TOKEN` authenticates
readiness requests and is not used by the test sender. Enter secrets in
the editor, never in shell command arguments, chat, or repository files. Keep
this file outside container mounts. Rotate these copied credentials alongside
the app credentials; recheck root ownership and mode 0600 after editing:

```sh
rtk sudo stat -c '%U %G %a' /etc/jamis/watchdog.env
```

Expected: `root root 600`.

## Explicit test message (requires separate approval)

This sends one real DM to the configured Operator using host Python directly.
It does not call Docker, Jamis, PostgreSQL, or ClickHouse. No production services
need to be stopped.

```sh
rtk sudo systemd-run --wait --pipe --collect --unit=jamis-watchdog-smoke --property=EnvironmentFile=/etc/jamis/watchdog.env /usr/bin/python3 /usr/local/libexec/jamis-watchdog --test-notification
```

Expected output: `watchdog: test notification accepted` (exit 0). Separately
confirm receipt of the `JAMIS WATCHDOG TEST` message with its UTC observation
time. Provider acceptance is not proof of handset delivery.

`rejected` (exit 1) means HTTP 4xx or a recognized provider `ERROR` response.
`unknown` (exit 1) means acceptance cannot be established, including timeout,
connection loss, HTTP 5xx, redirects, oversized/malformed responses, or
contradictory success fields. A success requires a nonempty message handle,
`QUEUED`, `SENT`, or `DELIVERED`, and no provider error. Output never includes
provider bodies, handles, credentials, or phone numbers. Invalid configuration
exits 2 before sending.

The explicit test mode never retries. An unknown result may already have sent
a DM. Obtain approval before another test because it can duplicate the message.
Do not infer production monitoring from a successful smoke.

## Local verification

```sh
rtk python3 -m unittest infra.test_host_watchdog
```

Tests use fake credentials, mocked transport, and a loopback HTTP server for
stalled headers and trickling bodies. They never send to Sendblue. The production
endpoint is fixed HTTPS and cannot be overridden through configuration.

## PostgreSQL readiness (Stage 2)

`GET /readyz` uses the existing `API_TOKEN` through SimpleAuth. Missing or incorrect
credentials receive HTTP 401 before database checkout. Existing `/api/*`
protection and Mastra's `/api` and `/api/auth/*` exceptions remain unchanged.
The route is authenticated even when reached through an existing public proxy;
loopback is only the watchdog's preferred address.

Every HTTP 200 response (`{"status":"ready"}`) requires a fresh `SELECT 1` on the
same PostgresStore writer pool used by the app. SQL, connection, checkout, or
timeout failures return HTTP 503 (`{"status":"unavailable"}`). Responses use
`Cache-Control: no-store` and contain no database error, URL, or credentials.
This checks connectivity and querying, not database write capacity, ClickHouse,
model access, or scheduler progress.

The route has a four-second total checkout/query deadline, leaving margin inside
the host's five-second request deadline. A failed or timed-out checked-out client
is destroyed with `release(true)`. Application pool settings are unchanged.
Only one readiness operation can be pending; overlapping probes return 503.
The installed pg pool cannot cancel an individual pending checkout, so a timed-out
checkout retains that one slot until it settles. A late client is destroyed without
running SQL. Further probes return 503 meanwhile, rather than queueing more work.
If a connecting socket never settles, readiness stays unavailable until it does
or the app restarts. No unbounded waiter/query accumulation or cached success.

### Local smoke

Use a disposable app/database instance with fake credentials, never the production
database. The automated native HTTP tests run with `JAMIS_TEST_DATABASE_URL` set
to the existing disposable loopback port 15458 `jamis_sessions_test` fixture:

```sh
rtk bun --no-env-file test src/mastra/readiness.test.ts
```

Against the disposable app's HTTP listener, request `/readyz` without auth and
observe 401. Put `header = "Authorization: Bearer <fixture-token>"` in a temporary
mode-0600 curl config file using an editor. Then run:

```sh
rtk curl --max-time 5 --config /private/tmp/jamis-watchdog-curl.conf -i http://127.0.0.1:4111/readyz
```

Expect 200/ready. Stop only the disposable PostgreSQL container and repeat to
observe bounded 503/unavailable. Restart it, wait for `pg_isready`, then repeat
to observe 200/ready. Remove the temporary curl config afterward. When guiding
an Operator, perform one command at a time and wait for its result.

After separately approved app deployment, repeat only the authenticated healthy
loopback smoke on the VPS using its actual API token in a root-only curl config.
Do not stop production PostgreSQL. Enable the host timer only after this succeeds and deployment/message authorization is granted.

API contracts checked against installed Mastra 1.71.0 and PostgresStore 1.27.1,
plus official [Mastra custom route authentication](https://mastra.ai/docs/server/custom-api-routes#authentication)
and [node-postgres checkout/release documentation](https://node-postgres.com/apis/pool#releasing-clients).

## Persistent host checks (Stage 3)

Deployment installs the script and units but does not enable a new timer. An
already enabled timer retains its schedule across deployments. Before the first
enablement, verify authenticated production readiness and the five credentials
in `/etc/jamis/watchdog.env`. The file must be regular, root-owned, mode 0600;
`--check-config` validates its permissions and the supplied values without sending:

```sh
rtk sudo systemd-run --wait --pipe --collect --unit=jamis-watchdog-config --property=EnvironmentFile=/etc/jamis/watchdog.env /usr/bin/python3 -B /usr/local/libexec/jamis-watchdog --check-config
```

Expected: `watchdog: configuration valid`. This checks shape, not credential
validity with the providers. Use the already received Stage 1 DM as transport
proof. Rotate all copied credentials alongside their application equivalents.

Before enabling, confirm `/`, Docker data, and PostgreSQL/ClickHouse volume
mountpoints are on the same filesystem using `docker info --format
'{{.DockerRootDir}}'`, `docker volume inspect` for the actual database volumes,
and `findmnt -T <path>` on each reported path. If they differ, stop: this watchdog
only monitors `/` and the plan must be revised for that layout.

Keep the separate retention proposal (`docker-compose.prod.yml` and
`clickhouse/log-retention.xml`) in its own fix/PR. Validate it against disposable
ClickHouse matching production before enabling production monitoring. Check
existing versus newly created diagnostic tables; do not assume the XML reclaims
historical log space. This recommendation does not authorize retention changes.

After separate deployment and notification authorization, install via the normal
deployment path, or install just these files from the approved checkout:

```sh
rtk sudo install -o root -g root -m 0755 infra/host_watchdog.py /usr/local/libexec/jamis-watchdog
rtk sudo install -o root -g root -m 0644 infra/jamis-watchdog.service infra/jamis-watchdog.timer /etc/systemd/system/
rtk sudo systemctl daemon-reload
rtk sudo systemd-analyze verify /etc/systemd/system/jamis-watchdog.service /etc/systemd/system/jamis-watchdog.timer
```

After the credential, filesystem, and readiness gates above:

```sh
rtk sudo systemctl enable --now jamis-watchdog.timer
```

This authorizes periodic real alert/recovery sends. Do not run during an isolated
smoke. The timer runs every 60 seconds with one-second accuracy, without app or
Docker unit dependencies. Each oneshot has a 45-second start deadline and a
five-second stop deadline. No overlapping timer invocations; a host file lock
also excludes simultaneous manual `--check` runs.

Inspect after at least two ticks:

```sh
rtk sudo systemctl list-timers jamis-watchdog.timer
rtk sudo journalctl -u jamis-watchdog.service -n 20 --no-pager
rtk sudo cat /var/lib/jamis-watchdog/state.json
```

Healthy startup sends nothing. Readiness successes saturate at two, failures at
three. Disk alerts at unrounded 85% and recovers strictly below 80%; unavailable
disk evidence never recovers or retries a disk notice. Readiness requires HTTP
200 with the small ready response within five seconds, including body reading.

State directory mode is 0700; state and lock files are 0600. The versioned state
contains only current checks, streaks, incident UTC epoch times, and the latest
notice outcome/retry time. Writes use a same-directory temporary file, fsync,
atomic replacement, and directory fsync. Corrupt, oversized, unsafe, or unwritable
state fails closed with a sanitized journal error. Do not delete/reset state to
clear errors: preserve it for diagnosis, stop the timer, and repair the cause.
A full disk can prevent state writes and suppress alerts.

Accepted notifications stay silent. Rejected notices retry after five minutes;
unknown acceptance waits 30 minutes, labeled as a possible repeat. Send intent
is persisted before POST, so a crash cannot cause an immediate blind retry.
Unknown attempts can still duplicate a DM. Recovery cancels stale alert retries;
only accepted or possibly accepted alerts need recovery. A new incident replaces
an obsolete recovery retry. Both checks share at most one POST per invocation.
Acceptance is not proof of handset receipt. No reminders or automatic remediation.

### Isolated smoke and rollback

Use disposable local Linux with systemd, fake credentials, a loopback readiness
and Sendblue stub, and disposable state. Keep production thresholds and unit
timeouts unchanged. A test-only ExecStart wrapper may substitute stub transport,
filesystem observations, and a fake clock; do not add production endpoint overrides.
Exercise three failures, two successes, 85/80 hysteresis, rejected/unknown cooldowns
across new processes, and a stalled HTTP request. Confirm an unresponsive process
is killed within the 45-second start plus five-second stop bounds. Inspect the
stub's captured messages, never a real phone. Guide each manual command separately.

Rollback stops future ticks, then any current invocation:

```sh
rtk sudo systemctl disable --now jamis-watchdog.timer
rtk sudo systemctl stop jamis-watchdog.service
```

An in-flight POST may already have been accepted. Keep the state file when
stopping or reinstalling; its unknown outcome/cooldown prevents immediate retries.
Do not roll back to Stage 1 while leaving the timer enabled (`--check` is new).

Timer and timeout contracts follow official
[systemd.timer](https://manpages.debian.org/bookworm/systemd/systemd.timer.5.en.html)
and [systemd.service](https://manpages.debian.org/bookworm/systemd/systemd.service.5.en.html).
