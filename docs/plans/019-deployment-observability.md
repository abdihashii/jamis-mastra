# 019: Deployment observability

Status: JAM-67 Stages 1 and 2 deployed and verified. Stage 3 has not started.

Linear: [JAM-67](https://linear.app/abdirahman-haji/issue/JAM-67/make-the-full-jamis-deployment-observable).

JAM-67 supplies bounded, read-only evidence behind the existing Monitoring and Incident triage facades. [ADR 0021](../adrs/0021-operational-snapshots-compose-owned-evidence.md) fixes the source ownership and output boundary; [ADR 0020](../adrs/0020-triage-incidents-from-owned-evidence.md) fixes exact application correlation. [ADR 0003](../adrs/0003-provider-and-scripted-provisioning.md) keeps host privilege outside the app container. JAM-68 owns Deployment Monitoring composition and Jamis routing; JAM-69 owns Deployment Incident triage. Neither is implemented here.

## Fixed evidence inventory

| Component | Authoritative evidence available now | JAM-67 seam or gap |
| --- | --- | --- |
| Host | Kernel `/proc` state and systemd journal | A host-owned, fixed probe must select safe fields before the app reads them. Local state cannot prove external reachability. |
| Docker runtime | Docker daemon's fixed Compose container states and resource counters | The app has no Docker socket or host command access. Probe only the fixed `jamis` services and expose enums and bounded numbers, never raw Docker output. |
| `app` | Its executing Mastra process, Docker state, and ClickHouse application traces | Keep execution evidence separate from product outcomes. A responsive evidence tool proves only that this app instance answered. |
| Postgres | Native read-only SQL and existing durable Mastra and Fantasy records | Check current database availability. Preserve durable outcome authority and its natural season or exact-week scope. |
| ClickHouse | Existing Mastra observability store and native read-only queries | Check current store availability and query bounded traces, logs, or metrics through its existing API. |
| Cloudflare Tunnel | Fixed `cloudflared` container state and locally retained tunnel diagnostics | Select only categorical local evidence. A running container alone does not prove the Cloudflare edge or public route works. |
| Tailscale private access | Host `tailscaled` state and local Tailscale status | Select only local connection state. It does not prove the Operator's device can reach the box. |
| Application traces and durable outcomes | ClickHouse traces with the existing safe Sendblue digest and allowlisted Codex auth events; Postgres Fantasy recap runs | New scheduled attempts persist their exact trace ID when available. Historical or untraced runs can still have a null trace ID and must expose that gap. |

Each fixed result identifies its component and source, uses a UTC observation time, names its source-owned scope, distinguishes fresh, stale, and unavailable evidence, and lists explicit gaps. Results contain only fixed classifications, bounded counts or measurements, UTC times, and safe exact references. Nearby events remain explicitly uncorrelated unless an existing identifier proves identity. No result infers cause from time proximity.

An on-demand host probe serves one fixed, read-only request over a local Unix socket mounted into `app`. The host selects allowlisted JSON before replying. A failed or timed-out probe makes only its covered components unavailable. Source-native recent events may be selected where retained; older missing evidence is an explicit gap, not a new retention promise. The app never receives a host command, Docker socket, raw log, or arbitrary metadata through this seam. Do not add polling, a generic source interface, reader registry, central evidence store, status rollup, synthetic product transaction, or provider-status poll.

## Preparation: Record the source inventory and implementation boundary

**Goal:** Make the fixed source map, authority, freshness, and safety contract reviewable before runtime changes.

**Critical file:** this plan. Existing glossary terms and ADR 0021 already cover the domain and architecture; add no duplicate term or ADR.

**Verify:** Re-read JAM-67 through JAM-69 and ADRs 0003, 0020, and 0021; run `rtk git diff --check`; inspect the full documentation diff.

**Demo:** Every fixed component has an authority and an honest evidence gap in the table above. Stage 1 is the first runtime slice.

**Proposed commit:** `docs: plan Deployment observability`

## Stage 1: Prove the host and Docker boundary on the deployed box

**Goal:** Publish safe current host and Docker evidence without giving `app` host execution or Docker control.

**Critical files:** a fixed host probe and systemd socket/service under `infra/`, `infra/deploy.sh`, `docker-compose.prod.yml`, a small internal Deployment evidence reader/tool, and its focused test.

**Contract:** Install a root-owned, socket-activated probe through the existing deploy path. Each request runs only fixed read-only host and Docker checks, selects fixed Compose component names, and returns bounded allowlisted JSON with a UTC observation time. Mount only the Unix socket directory into `app`; the service accepts no command, path, component name, or other caller-supplied parameter. A connection failure, deadline, or malformed response is unavailable for that source. Keep the operator's existing host privileges and the app's unprivileged container user. Register one authenticated direct-tool proof surface without attaching it to Jamis; later facade work will call the underlying reader. No arbitrary input, Docker socket, or raw output crosses the boundary.

**Verify:** Focused checks reject planted secrets, phone numbers, raw names, and arbitrary fields; prove connection failure, deadline, malformed response, and partial probe results. Run `rtk bun test`, `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run build`, and `rtk git diff --check` before Stage 1 commit review. After separate commit, push, and deployment approvals, confirm socket activation and execute the authenticated tool on the deployed box. Confirm `app` has no host shell or Docker socket; inspect the output for UTC time, fixed identity, freshness, and gaps.

**Demo:** A deployed direct call returns safe host and Docker evidence. A focused failure check shows that an unavailable Docker check does not erase host evidence.

**Proposed commit:** `feat: expose safe host and Docker evidence`

**Implementation record (2026-09-24 UTC):** Commit `b9a9a57` is pushed on `abdirahman/jam-67-make-the-full-jamis-deployment-observable` and deployed on the production box. The fixed socket probe, unprivileged app mount, and authenticated direct tool passed 325 Bun tests, 2 Python tests, typecheck, lint, build, Compose config, and diff checks before deployment. The deployed Git revision is `b9a9a57`; `jamis-evidence.socket` is active at `root:jamis 0660` and recorded one accepted connection. The `app` image runs as `bun` (UID 1000), mounts only `/app/data` and `/run/jamis-evidence`, and has no Docker socket. A direct tool call without the API token returned 401; the authenticated call returned 200 with fresh host and Docker evidence observed at `2026-09-24T00:26:59Z`. All four fixed Compose services reported `running`. The 667-byte result contained only the fixed source fields, UTC time, bounded measurements, and explicit gaps; no raw Docker output or extra keys appeared. JAM-68 routing, JAM-69 triage, and iMessage smoke remain out of scope.

## Stage 2: Preserve Codex auth failures and exact application correlation

**Goal:** Keep the sanitized reason for a failed Codex-authenticated execution after container replacement, and anchor scheduled recap attempts to their actual trace.

**Critical files:** `src/mastra/gateways/openai-codex-auth.ts`, `src/mastra/gateways/openai-codex-gateway.ts`, `src/mastra/workflows/fantasy-weekly-recap.ts`, existing Fantasy run persistence only where the trace handoff needs correction, and focused tests.

**Contract:** At the authentication failure boundary, emit one ClickHouse-backed Mastra observability event with a fixed allowlisted reason code, UTC occurrence time, and the active trace ID. Cover missing credential, refresh rejection or transport failure, persistence failure, and authorization failure after retry without storing tokens or provider responses. Use the installed Mastra span and logger APIs; prove actual correlation rather than deriving it from time. Persist the scheduled run's exact trace reference when available and expose an explicit gap if tracing is absent. Keep channel-safe errors generic and existing durable Fantasy outcomes authoritative.

**Verify:** One focused runnable check exercises each reason with hostile provider text, trace correlation, event export, and container-independent retrieval from persistent observability storage. Verify a scheduled attempt's stored trace points to that exact trace. Run the full Stage 1 repository gate. Inspect exported event fields and a controlled replacement/restart test without a live provider transaction.

**Demo:** A controlled failed model execution yields its safe reason and exact trace from ClickHouse after the emitting process is replaced; the Fantasy attempt links to the same trace when that failure occurred in its scheduled execution.

**Proposed commit:** `feat: retain correlated Codex auth failures`

**Implementation record (2026-09-24 UTC):** Commit `2a157f0` is pushed and deployed. Codex auth failures emit one Mastra event on the actual model execution trace with a fixed reason code and UTC occurrence time. The export processor retains only those two metadata fields; the trace ID remains in Mastra's trace fields. The scheduled Fantasy step creates an attempt trace when the scheduler supplies none, passes its tracing context into model generation, and persists that exact trace ID through the existing run claim. Without tracing, the run retains a null trace ID for the existing explicit evidence gap. Focused tests cover all six reason codes, hostile provider text, event export, direct and scheduled model correlation, and generic channel errors when event recording fails. The repository gate passed 328 Bun tests, 2 Python tests, typecheck, lint, build, and diff checks. A controlled failed model execution was read from local ClickHouse in a fresh process after its emitter exited. A separate controlled scheduled attempt wrote a Postgres run whose trace ID matched its ClickHouse attempt span and Codex auth event, without a live provider transaction. The production checkout and rebuilt app run `2a157f0`; the app container was `running` with zero restarts, and `/api/agents` returned 401 without a token and 200 with the app token. No production provider transaction was made for this smoke.

## Stage 3: Complete the fixed Deployment reader set

**Goal:** Return independent safe evidence for `app`, Postgres, ClickHouse, Cloudflare Tunnel, and Tailscale alongside Stage 1's host and Docker results.

**Critical files:** the host probe only for Tunnel and Tailscale local signals; the internal Deployment evidence reader/tool for app and data-service checks; focused tests. Do not alter Jamis routing or either deep facade's product contract.

**Contract:** Use source-native read-only checks and existing storage clients. Apply one deadline and a source-relevant bound to each check, allowlist before any result reaches the tool, and combine the fixed readers with independent failure handling. Preserve source-specific fields and time scopes instead of flattening them into one health status. Distinguish local Tunnel/Tailscale evidence from end-to-end reachability. Keep existing application request correlation exact and host/container context explicitly uncorrelated.

**Verify:** Focused checks cover every fixed component, absent/stale data, one reader failure beside successful readers, exact application references, uncorrelated nearby events, and hostile raw fields. Run the full Stage 1 repository gate. Execute the authenticated tool on the deployed environment before any Jamis routing smoke; verify all fixed identities, UTC freshness, explicit gaps, bounded output, and no raw content.

**Demo:** The deployed reader set reports each fixed component or its own unavailable result. A failed Postgres read does not erase successful host, Docker, ClickHouse, Tunnel, or Tailscale evidence.

**Proposed commit:** `feat: read fixed Deployment evidence`

After each stage, show the diff and proposed commit and wait for explicit commit approval. Push and deployment each need separate approval. Close with the full repository gate and report final commits and production smoke results. No iMessage smoke is required in JAM-67 because JAM-68 owns the operator-facing Deployment snapshot.
