# Host watchdog setup

Stage 1 provides a standalone test sender; Stage 2 adds app PostgreSQL readiness.
No timer or persisted notification state is installed yet. Requires host Python 3 on Linux;
the sender uses SIGALRM in the main thread for a 15-second total HTTPS deadline,
including DNS, TLS, and response consumption. TLS certificate verification remains
on. There are no redirects or automatic retries, and response reads stop at 16 KiB
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

There is no automatic retry in Stage 1. An unknown result may already have sent
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
Do not stop production PostgreSQL. The host timer remains a later stage.

API contracts checked against installed Mastra 1.71.0 and PostgresStore 1.27.1,
plus official [Mastra custom route authentication](https://mastra.ai/docs/server/custom-api-routes#authentication)
and [node-postgres checkout/release documentation](https://node-postgres.com/apis/pool#releasing-clients).
