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


## Typed execution boundaries (JAM-77, 2026-10-10 UTC)

This amendment supersedes the original raw `Agent.agents` delegation and instruction-only boundary above. [Plan 029](../plans/029-jamis-agent-architecture.md) records the accepted stages, deployed revisions, tests and live limits. Jamis remains the only Operator-facing conversational agent. The separately registered scheduled Fantasy agent is not an Operator conversation root.

### Ownership and composition

Each scoped assignment has one outcome owner. Jamis may own a cross-domain task or a task with no justified domain specialist; a domain owner may use an explicitly permitted Research capability contribution without handing over ownership. Domain-to-domain calls and further capability-agent delegation remain unavailable. Initially there is one active conversational task with sequential contributions, no parked queue, concurrent task engine, automatic reminders, or background continuation. An unrelated request supersedes an unfinished check; an explicit return uses fresh execution and revalidated context.

Every Operator response uses Jamis's dry, concise voice while preserving supported claims, source-to-claim links, required domain details, material caveats and honest gaps. Exact proposals and quoted artifacts, including Fantasy group drafts, retain their bytes and own quoted voice. Specialist results are evidence, not ready-made replies. Resolve a blocker within existing scope and authority before escalating; ask for missing input, approval or a decision the owner cannot make. Delegation never expands permissions. Invalid arguments need correction, not speculative retries or wider access.

For a calendar-plus-weather plan, retrieve each bounded contribution sequentially. If Weather fails, retain the useful verified calendar portion, name the forecast gap and withhold weather-dependent advice. A failed prerequisite cannot support dependent claims or an assertion of full completion. No background work remains implied.

### Control and evidence

Native invocation tools expose strict assignment schemas and specialist-owned results:

| Handback | Owner/caller meaning |
| --- | --- |
| `completed` | Scoped completion claim with domain result, checked against retrieved evidence and required prerequisites. |
| `partial` | Independently useful domain result plus nonempty gaps; current attempt ends. |
| `needs_help` | Specific input, bounded contribution or runtime-bound pending approval need, optionally with validated progress. |
| `blocked` | Safe reason with optional useful validated progress; no permitted continuation within the current scope. |
| Runtime failure | Native execution/validation error normalized by caller code, retaining only independently validated progress. Never a model-authored control case. |

Only the first four cases are model-authored. Trusted task/caller identity, scope, authority, actual decisions and external effects stay in application records, not model-authored permission fields. Approval needs must match the authoritative pending operation. A normally terminated invocation can return blocked; workflow `success` and model termination do not prove the task completed. Decline, cancellation, supersession, failed execution and uncertain effects remain distinct runtime facts. Schema validation proves shape and bounded evidence prerequisites, not perfect provenance interpretation, judgment, wording or universal privacy.

Weather validates its resolved place/date and readings against actual tool results. Research retains adjacent claim/source mappings, original provenance, retrieved evidence kinds, limitations, at most three cited sources and the existing exact refusal/access-metadata rules. Unread candidates are never evidence; abstract-only results remain labeled. Accounts preserves exact Gmail tool records through invocation-owned references, Calendar coverage gaps and exact Linear read outcomes. Missing, ambiguous, denied, truncated, unavailable and empty evidence remain distinct. Fantasy completed means an actual matching saved draft for review, never sent. Each specialist owns its payload rather than one universal evidence schema.

### Native invocation and protected context

`invoke_weather`, `invoke_personal_accounts`, `invoke_research` and `invoke_fantasy_broadcast` are the sole enforced specialist entry paths. Native `createTool` execution calls the internal agent's `generate()` using strict structured output with an object-root `{ handback }` envelope, then explicitly validates and returns its handback. Reject missing output and native validation-error values; no prose parsing, success fallback, alternate provider/model or blanket retry. Callers cannot choose generation options, instructions, models, toolsets, contexts, memory bindings or limits.

Construct internal agents with public `AgentConfig.mastra` on the common runtime, then register public roots/workflows through public `addAgent()`/`addWorkflow()`. Direct invocation preserves specialist instructions, fixed limits/concurrency, cooperative abort and safe parent/root attribution. It replaces the relevant raw-delegation hooks deliberately. Internal agents stay out of the public registry. Workflow reasoning uses the same checked boundary, with only phase-appropriate reads/preparation and executable prerequisites.

Build each callee context from an explicit allowlist. Research has no inherited account snapshot, channel object, credentials, memory or caller capability; its source contracts/identities belong to its own context. Constrain explicit private-to-public questions as well as messages/context ([ADR 0011](0011-jamis-online-research.md#architecture-amendment-permitted-domain-callers-2026-10-08-utc)). Protected traces/logs/metrics preserve safe parent/root identities and numeric usage without adding private source data or runtime authority. Existing private tool-result retention policies remain; protection of exports does not imply deletion of private storage.

Recovery belongs to the executable owner that knows whether replay is safe. Calendar's existing one credential refresh and Linear's one pre-mutation preflight retry remain; Research gets no application retry or provider fallback. A failed read cannot establish an empty account or a negative public fact. An unsuccessful model/reply can coexist with a confirmed effect, which must remain truthfully reportable. Task outcome, response generation, Channel reply acceptance and handset receipt are separate facts; the silent-reply fallback remains needed.

### Naming, scope and rationale

New/migrated Jamis-owned custom tool IDs and registrations use `verb_object` snake_case, aligned with the operation: `draft_`/`propose_` for preparation and `send_`/`create_`/`write_` for effects. TypeScript identifiers keep local style; framework/provider-owned names retain upstream naming. Changes carry all callers, contracts, fixtures and historical telemetry mappings. Unrelated legacy tool-name debt is deferred.

Use adaptive agents inside code-enforced execution boundaries. Code owns exact action arguments, identity, authorization, transitions, safe recovery and defined approval-dependent sequencing. Agents interpret tasks, select allowed tools, evaluate evidence and prepare results. Prefer small native workflows for concrete predictable procedures; undeclared dependencies stop and report rather than letting a model invent permission or independence. Decline skips the exact action and its declared dependent steps. Independent, already requested work may proceed only where the defined procedure proves its prerequisites. An explicit whole-task stop ends it. Decline does not undo effects, become a failure, generate replacement proposals or authorize retries.

No router, verifier agent, general registry/approval ledger, dependency language, dynamic model-authored workflow, memory redesign, new specialist, Gmail draft API or email send is introduced. Every future email send needs separate exact recipients/content confirmation; final To/Cc/Bcc, subject, body and attachments require review, material changes require new confirmation, and Linear approval cannot authorize email. Its future syntax/integration remain unspecified. Scheduled recap authority and passive group ingestion retain [ADR 0017](0017-fantasy-group-is-passive-channel-context.md).

This applies APOSD's information hiding and simplest useful interfaces, Ponytail's reuse of existing/native capabilities, and the distinction between model judgment and enforceable transitions discussed in [David Khourshid's talk](https://www.youtube.com/watch?v=1rMgw0Q5MgY). [Anthropic's effective-agents guidance](https://www.anthropic.com/engineering/building-effective-agents) supports simple adaptive agents and predefined workflows for ordered tasks. [LangGraph replay guidance](https://docs.langchain.com/oss/python/langgraph/graph-api#re-execution-and-idempotency) reinforces keeping effect identity/protection at the boundary; it is comparative evidence, not a new dependency or Mastra/Linear exactly-once guarantee. [Ousterhout's APOSD excerpt](https://web.stanford.edu/~ouster/cgi-bin/aposd2ndEdExtract.pdf), especially chapters 6 and 9, informed the boundary design. The Operator's role-model draft supplied the initial conversation/owner/capability distinction; accepted decisions above and in the linked ADRs supersede that starting hypothesis.

### Installed-framework evidence and limits

Verified during plan 029 against `@mastra/core@1.71.0` and `@mastra/pg@1.27.1`:

- Native `Agent.agents` rebuilds text/metadata without forwarding the structured object. Direct `generate()` supports it; native agent workflow steps support typed structured output but do not attach an otherwise standalone agent to Mastra or project its context.
- Strict structured-output failure throws; native tool validation can instead return a validation-error value. Both paths require rejection. Native in-memory result references do not establish persistent continuation.
- Native approval/suspension events do not replace Sendblue presentation, decision binding or routing. Workflow `bail()` can return success after rejection, so task completion stays separate.
- `AgentConfig.mastra`, `addAgent()`, `addWorkflow()` and `isValidationError()` are public seams. Authenticated root-tool/workflow routes still need executable authority/admission checks.
- With running snapshots persisted, native resume claims suspended-to-running atomically when storage supports concurrent updates. Installed Postgres implements expected-status comparison under a row lock. This cannot make operation/workflow/channel records atomic or guarantee exactly-once messages.
- The native resume claim precedes application step authority. A denied direct resume can fail a run despite zero draft/effect; channel admission must precede that claim.
- Resume merges missing stored context values; raw context entries can serialize. Never persist executable authority. Native cancellation catches storage-update failures and cannot undo effects; durable eligibility checks remain necessary.
- Disable automatic active-run restart and workflow/step retries for the action-bearing procedure. Dynamic workflows are a deferred beta option; graph/schema validation alone cannot prove authorization, replay safety or semantic independence.

Source locations: installed `dist/agent/agent.d.ts`, `dist/agent/subagent.d.ts`, `dist/agent/types.d.ts`, `dist/mastra/index.d.ts`, `dist/tools/validation.d.ts`; embedded agent/workflow/step source in `agent-BOxKOk3n.js.map`, tool validation in `tool-D87M4CXT.js.map`, and `WorkflowsPG.supportsConcurrentUpdates()`/`updateWorkflowState()` in Postgres `dist/index.js`. Version-specific findings require re-verification on upgrade.

Embedded documentation: [subagents](../../node_modules/@mastra/core/dist/docs/references/docs-subagents.md), [generate](../../node_modules/@mastra/core/dist/docs/references/reference-agents-generate.md), [structured output](../../node_modules/@mastra/core/dist/docs/references/docs-agents-structured-output.md), [agents/tools in workflows](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-agents-and-tools.md), [overview](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-overview.md), [control flow](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-control-flow.md), [HITL](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-human-in-the-loop.md), [suspend/resume](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-suspend-and-resume.md), [snapshots](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-snapshots.md), [state reader](../../node_modules/@mastra/core/dist/docs/references/reference-workflows-workflow-state-reader.md), [request context](../../node_modules/@mastra/core/dist/docs/references/docs-server-request-context.md), [cancel](../../node_modules/@mastra/core/dist/docs/references/reference-workflows-run-methods-cancel.md), [error handling](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-error-handling.md), [server routes](../../node_modules/@mastra/server/dist/docs/references/reference-server-routes.md), and [dynamic workflows](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-dynamic-workflows.md).
