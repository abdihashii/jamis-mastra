# Jamis as Mastra supervisor

Jamis is the adaptive Mastra supervisor for the personal agent system. It is the only channel-facing public agent. It answers directly when it can, delegates bounded work to internal subagents when needed, and returns one operator-facing response.

## Context

The iMessage channel was intentionally completed against `weather-agent` alone in [plan 005](../plans/005-imessage-channel.md). That proved the channel boundary without deciding the broader personal-agent architecture. Mastra channels remains the channel integration boundary ([0007](0007-mastra-channels-over-direct-integration.md)), and the public webhook path remains protected as recorded in [0008](0008-public-webhook-path-through-access.md).

The next slice needs ordinary conversation and live-weather work to reach the operator through one agent, without duplicating the existing weather capability or adding a fixed routing system. The implementation details and acceptance checks are in [plan 006](../plans/006-jamis-supervisor.md).

## Decision

- Use Mastra's adaptive supervisor pattern. Jamis decides whether to answer directly or delegate, then synthesizes the final response.
- Register only Jamis on the Mastra instance. Subagents are internal and have no direct channel, API, or Studio presence.
- Keep each tool scoped to its owner. `weatherTool` remains available only to `weather-agent`; Jamis does not duplicate that capability.
- Put the durable channel conversation and observational-memory configuration on Jamis. A subagent receives isolated delegation context rather than becoming the canonical conversation owner.
- Treat a subagent result as evidence for Jamis to use, not as a ready-made channel reply.
- Accept model-driven delegation. The model, guided by Jamis's instructions and subagent descriptions, chooses when bounded work is needed.

## Alternatives not taken

- **Routing workflow.** A fixed route is unnecessary for the current adaptive choice between direct conversation and bounded weather work. It would add orchestration that duplicates the supervisor's responsibility.
- **Council broadcast.** Calling several agents for each request adds cost and reconciliation work without a current need for parallel independent results.
- **Giving Jamis `weatherTool`.** That would blur tool ownership and make the internal weather boundary unenforceable.

## Consequences

- External clients and channels address Jamis, while `weather-agent` remains an implementation detail.
- Jamis keeps the canonical operator conversation. Existing `weather-agent` records stay retained, with no thread migration.
- Delegation behavior depends on the model following the documented boundary. Jamis's instructions, subagent descriptions, and bounded execution settings are the controls accepted for this slice.
- Future capabilities can add their own subagent only when Jamis needs a distinct bounded delegation boundary; they do not become public agents by default.
