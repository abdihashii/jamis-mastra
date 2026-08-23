# Jamis performs human-in-the-loop as text checks, not approval cards

Jamis gains human-in-the-loop as a built-in `askUserTool` "check": it pauses to ask the operator a clarifying question or get confirmation before acting, renders the question as plain text through a custom channel renderer, and acts on the operator's answer when their reply arrives. The check is a plain question on the text-only iMessage surface, never an Approve/Deny card, because Sendblue iMessage cannot render cards and, in the installed `@mastra/core@1.61.0`, no channel driver renders a suspended `ask_user` question natively.

## Context

Jamis has no tools of its own today. It answers ordinary conversation and delegates current weather to `weather-agent` and other online verification to `research-agent`. It cannot ask the operator a question mid-run; a clarifying reply today is ordinary text that ends the run.

Mastra's built-in [`askUserTool`](https://mastra.ai/docs/agents/tools#built-in-tools) (`ask_user`) suspends the agent run and returns the operator's answer as the tool result. Two adjacent settings matter. `defaultOptions.autoResumeSuspendedTools` replies with a system-prompt suffix that, on the operator's next message on the same thread, has the model re-invoke the suspended tool with the answer as `resumeData` in a new run rather than resuming the parked one. `toolDisplay` controls how the channel host renders tool calls, and accepts a function form, `ToolDisplayFn`.

Three facts from the installed runtime determine the design. First, no channel driver handles the `tool-call-suspended` chunk, so a suspended `ask_user` question is not surfaced as a message by any string `toolDisplay` mode. Second, `ToolDisplayFn` receives a `running` event carrying the full tool arguments only under the streaming driver; `resolveStreaming` defaults to disabled, and the static driver skips the function on `tool-call`, so the renderer requires `streaming: true`. Third, `requireApproval` renders an interactive Card regardless of mode, and the Sendblue adapter's `renderOutbound` returns an empty string for a card, so `postMessage` drops it; approval cards are unusable on iMessage, not merely unpresentable.

## Decision

- Give Jamis human-in-the-loop through the built-in `askUserTool`, a "check" in the project glossary. It is the single primitive for clarifying questions and confirmations in this slice.
- Render the check with a `ToolDisplayFn` that posts the full `ask_user` question (from the `running` event's `args.question`) as plain text and returns nothing for every other tool event, so delegations stay quiet. This requires `streaming: true` on the Sendblue adapter; otherwise the static driver never passes the `running` event to the function.
- Set `defaultOptions.autoResumeSuspendedTools: true` on Jamis so the operator's next message on the same durable thread supplies the answer through the documented auto-resume path. This is a prompt-level re-invocation in a new run, not a resumption of the parked run, and the parked run may remain listed as suspended; verify its cleanup rather than assuming it.
- Add `toolCallConcurrency: { limit: 8, strategy: 'called' }` so registering the suspending `askUserTool` does not force every delegation batch to run sequentially. The `'called'` strategy resolves concurrency from the tools actually invoked in a step.
- Raise `defaultOptions.maxSteps` from five to eight. The re-ask bound is per run, not cumulative across replies, because each operator reply starts a fresh run.
- Apply a balanced ask policy: Jamis checks before consequential or irreversible actions and whenever a clarification would change what it does; it otherwise acts, and may re-ask while the answer is ambiguous.
- Put `askUserTool` on Jamis only. Subagents do not ask; they return their result and Jamis performs the check and owns the conversation, consistent with [ADR 0009](0009-jamis-as-mastra-supervisor.md).
- Defer `requireApproval` and custom confirmation tools. Approval cards are dropped by the Sendblue adapter, and `askUserTool` already expresses confirmation as a textual question. The confirmation facet is policy-only until a write tool exists; nothing can be gated today.

## Alternatives not taken

- **`requireApproval` Approve/Deny cards.** Even under `toolDisplay: 'text'` the approval renders as a Card, and the Sendblue adapter drops cards silently, so a sensitive tool would park with no way to answer.
- **A string `toolDisplay` mode (`hidden` or `text`).** `hidden` suppresses the `tool-call` line entirely and `text` renders only a truncated tool-header (`running`) line; neither renders the suspended question, and `text` also turns on tool chatter for every delegation.
- **A custom confirmation tool.** A hand-written suspending tool would re-implement `askUserTool` and still face the same missing channel rendering.
- **A buttoned approval surface** (Studio or a web checkout). More control but new off-channel infrastructure; revisit only if a future action tool becomes frequent and consequential enough to justify it.
- **Giving subagents their own `askUserTool`.** This would split conversation ownership that belongs to Jamis.
- **Waiting for a newer stable.** The latest stable `@mastra/core` is `1.61.0`; only alphabets (`1.61.1-alpha`, `1.62.0-alpha`) follow, and none adds channel suspend-question rendering.

## Consequences

- Jamis can ask the operator and act on the answer. What the operator types is carried into the next run as the check's answer through auto-resume, and an answer that does not resolve the question lets Jamis re-ask.
- The question appears only because the `ToolDisplayFn` posts it under the streaming driver. Two live-only behaviors must be verified rather than assumed: the renderer may receive the `ask_user` invocation again on auto-resume and re-post the question, and the originally parked run may linger in `suspended-runs` after the answer is consumed.
- Delegations remain quiet: the renderer returns nothing for non-`ask_user` events, and `toolCallConcurrency: { strategy: 'called' }` keeps parallel delegation when `ask_user` is not the step actually calling.
- A suspended check survives process restarts because Jamis's Mastra instance uses the durable Postgres store; `listSuspendedRuns` re-discovers the pending run on the same thread.
- Whether Jamis checks is model-driven behavior guided by instructions and the tool's description, not a hard code invariant. Verification uses real-model matrices and channel smokes, not prompt-mocking.
- Streaming on Sendblue is the Chat SDK post-then-edit path; if it proves noisy for the ask flow, the renderer and streaming combination, not the check concept, is what to tune.
- `requireApproval` remains unused until a channel that renders buttons, or an explicit text-fallback decision, is adopted. Any future consequential tool must document its confirmation path against this ADR.
- `maxSteps: 8` raises only Jamis's ceiling for a check-plus-delegate turn; it does not change the research subagent's own `maxSteps: 5` or the Firecrawl one-search-three-scrape budget recorded in [ADR 0011](0011-jamis-online-research.md).
