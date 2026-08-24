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
- Treat the exposed Sendblue API key, API secret, and webhook secret as compromised. After a controlled post-deployment scan proves the boundary works, rotate them and verify a fresh trace. Purge historical matching ClickHouse records only after inspecting exact targets and receiving explicit approval.

## Alternatives not taken

- **Rely on `SensitiveDataFilter`.** It does not inspect `requestContext`, so it cannot protect this path.
- **Redact only `SENDBLUE_*` fields.** That depends on current field names and misses future credentials or runtime capabilities inside the same object.
- **Remove all `requestContext`.** It would discard safe diagnostic context without improving protection over removing the runtime-only entry.
- **Rotate credentials without an export change.** The next Sendblue message would leak the replacement credentials through the same path.
- **Disable ClickHouse export.** It removes useful operational traces rather than separating runtime renderer state from observability data.

## Consequences

- Channel traces retain ordinary execution evidence but omit the renderer's adapter, callback functions, and configuration.
- A focused regression check must prove that exported spans omit the entry while safe context remains available. A controlled production message and count-only scan prove the deployed boundary before credentials rotate.
- Future channel adapters and framework upgrades must preserve this boundary. Any new runtime-only request-context entry needs the same export review.
- Historical rows containing the old credentials remain a security concern until scoped deletion and a post-delete scan complete. The deletion is deliberately separate from ordinary deployment and requires explicit approval.
