# Fantasy group messages are passive channel context

The configured Fantasy group reuses Jamis's existing Mastra Channels Sendblue webhook, but its messages never enter Jamis or another agent. A local channel handler matches the stable Sendblue `group_id`, persists each message to one dedicated Mastra thread, and returns without calling the default agent handler. Operator direct messages continue to invoke Jamis, and all other inbound conversations remain ignored.

## Why

Mastra generates one webhook route per agent and adapter. Registering the same Sendblue line on a second channel-facing agent would create competing routes and risk duplicate processing, while a custom webhook would reverse [ADR 0007](0007-mastra-channels-over-direct-integration.md). Routing inside the existing verified webhook keeps one public ingress and makes the no-reply boundary explicit.

## Consequences

- The Fantasy Agent remains private and cannot be invoked by group conversation.
- Passive persistence must be idempotent by Sendblue message handle.
- The custom handler must catch and log persistence failures because Mastra acknowledges channel webhooks before background handlers finish.
- Phone numbers and raw group text remain private Postgres data and must not enter ClickHouse logs or Fantasy group output. A private operator alert may identify an unmapped sender so the mapping can be corrected.

## Architecture amendment: Operator-requested broadcast confirmation

Status: implemented and deployed in Stage 4 of [plan 029](../plans/029-jamis-agent-architecture.md#4-enforce-exact-confirmation-for-requested-fantasy-broadcasts) as `ad7df06`, with scoped handset cancellation and separately authorized exact-confirm broadcast receipt verified on 2026-10-10 UTC. During the [JAM-77 architecture decision](0009-jamis-as-mastra-supervisor.md#typed-execution-boundaries-jam-77-2026-10-10-utc), the Operator selected an application-enforced next-message gate for one-off requested broadcasts. Jamis shows the exact saved draft in the Operator DM; only the immediately following trimmed, case-insensitive `confirm` in that DM and active session authorizes sending those exact bytes to the configured Fantasy group. `decline`, any other next reply, and `/new` cancel the pending send. Changed text requires fresh review and confirmation. A draft ID or model-written approval does not authorize sending, and one confirmation cannot authorize multiple actions.

Application execution now requires native channel authority plus the saved draft's publication, DM/message/session/group binding, exact digest, and single-use claim. The existing broadcast record owns durable decision/claim/outcome facts; no separate approval ledger was added. The internal drafter has no send tool or raw delegation bypass. Passive group ingestion and scheduled weekly recap delivery keep their existing policies. The implementation follows the separately authorized Stage 4 plan. A live broadcast still requires separate explicit authorization.
