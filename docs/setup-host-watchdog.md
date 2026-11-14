# Host watchdog setup

Stage 1 provides only a standalone test sender. No timer, checks, readiness endpoint,
or persisted notification state is installed yet. Requires host Python 3 on Linux;
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
Phone numbers must be E.164, including the leading `+`. `API_TOKEN` is reserved
for the later readiness stage and is not used by this sender. Enter secrets in
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
