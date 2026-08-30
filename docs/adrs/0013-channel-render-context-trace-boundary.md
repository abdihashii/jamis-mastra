# Keep channel render context out of trace exports

Jamis treats channel render context as a runtime capability, not observability data. The complete render-context entry must be removed from exported spans before they reach ClickHouse. This leaves plain-text HITL behavior, channel delivery, and the existing sensitive-data filter unchanged.

## Context

On `@mastra/core@1.61.0`, the channel host stores `__mastra_chat_channel_render` in `RequestContext` so its output processor can deliver a response. The entry contains the live adapter and its configuration. Jamis's Sendblue adapter uses credentials from environment variables, including the webhook secret, so that runtime object must not be persisted.

Jamis exports spans through `MastraStorageExporter` to ClickHouse. Its existing `SensitiveDataFilter` processes `attributes`, `metadata`, `input`, `output`, and `errorInfo`, but not `requestContext`. A count-only production scan found all three Sendblue credentials in trace `requestContext`; the corresponding Postgres message scan found none.

The renderer needs this context while a channel run is live. Trace consumers do not. Removing an individual list of secret names would be brittle because the render context is an opaque runtime object that can gain new sensitive fields with an adapter or framework upgrade.

## Decision

- Add one internal span output processor ahead of `SensitiveDataFilter`. It removes the complete `__mastra_chat_channel_render` entry from the span's exported `requestContext` before `MastraStorageExporter` receives it.
- Keep `SensitiveDataFilter` for its existing fields. Do not replace it with a custom secret-name list, disable observability, or remove all request context.
- Do not change `src/mastra/agents/jamis.ts`, Sendblue message behavior, the webhook, or the channel allowlist. The defect is export scope, not the agent's clarification policy.
- Treat the exposed Sendblue API key, API secret, and webhook secret as compromised. The security recommendation is to rotate them after a controlled post-deployment scan proves the boundary works, then purge historical matching ClickHouse records only after inspecting exact targets and receiving explicit approval. This ADR does not assert that either operational action has occurred.

## Alternatives not taken

- **Rely on `SensitiveDataFilter`.** It does not inspect `requestContext`, so it cannot protect this path.
- **Redact only `SENDBLUE_*` fields.** That depends on current field names and misses future credentials or runtime capabilities inside the same object.
- **Remove all `requestContext`.** It would discard safe diagnostic context without improving protection over removing the runtime-only entry.
- **Rotate credentials without an export change.** The next Sendblue message would leak the replacement credentials through the same path.
- **Disable ClickHouse export.** It removes useful operational traces rather than separating runtime renderer state from observability data.

## Consequences

- Channel traces retain ordinary execution evidence but omit the renderer's adapter, callback functions, and configuration.
- A focused regression check must prove that exported spans omit the entry while safe context remains available. A controlled production message and count-only scan prove the deployed boundary.
- Future channel adapters and framework upgrades must preserve this boundary. Any new runtime-only request-context entry needs the same export review.
- Historical rows containing the old credentials remain a security concern until scoped deletion and a post-delete scan complete. The deletion is deliberately separate from ordinary deployment and requires explicit approval.

## Rollout record

On 2026-08-24, commit `754d4aab0f704f047e5f69b678a5fabdc0aba342` was deployed. A controlled signed Sendblue-channel probe produced one normal reply. A post-deployment count-only scan found zero matches for each configured Sendblue value in `mastra_span_events`, `mastra_trace_roots`, `mastra_trace_branches`, and `mastra_messages`.

Read-only historic scoping found 95 matching span-event rows, 19 root rows, and 62 branch rows from 2026-08-23T02:24:14.673Z through 2026-08-24T04:34:54.583Z. It also found 30 `system.query_log` rows across 15 query IDs from the original direct scan. Postgres messages had zero matches. Exact record identifiers are retained only in the restricted operator report.

On 2026-08-30, the operator reported API-key rotation and directed that no further Sendblue work proceed. This ADR does not verify a production configuration update, webhook-secret rotation, post-rotation scan, or historical deletion. The deployed boundary remains the decision and fresh-trace result. Historical remediation is explicitly unresolved.
