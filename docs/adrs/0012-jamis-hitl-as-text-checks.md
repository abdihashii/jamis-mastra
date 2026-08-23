# Jamis asks the operator in plain text on iMessage

Jamis performs human-in-the-loop on the text-only iMessage channel as a plain conversational ask: when a request is ambiguous or missing information that changes what Jamis would do, it asks the operator directly in its reply, waits for the next message, and may re-ask while the answer is still ambiguous. It does not use Mastra's `askUserTool` suspend mechanism or `requireApproval` approval cards on iMessage today. Those are deferred to a future channel that can render interactive elements or to a stable that surfaces a suspended `ask_user` question natively.

## Context

iMessage over Sendblue is a plain-text surface with no interactive cards or buttons: markdown is stripped to plain text and the adapter's `editMessage` throws. Mastra's own iMessage integration guidance sets `toolDisplay: 'text'` and notes "iMessage has no interactive cards for Approve and Deny actions."

Mastra offers two HITL primitives: `requireApproval` (pre-execution Approve/Deny card) and `askUserTool` (a built-in `suspend()` that asks a question and returns the answer as the tool result). Both are designed to render through a host that can show interactive prompts. On the installed `@mastra/core@1.61.0`, the suspend question is **not a renderable channel event**: the `ToolDisplayEvent` union is only `running | result | error | approval`, and the channel host never handles `tool-call-suspended`. Surfacing the question through a `ToolDisplayFn` requires capturing the `running` event that fires *before* suspension, which the static driver skips and only the streaming driver dispatches. But `streaming: true` "requires the underlying adapter to support post-and-edit streaming," and Sendblue cannot edit: its `stream()` posts every `\n\n`-delimited segment as a separate message, so multi-paragraph replies (research answers with a `Sources:` block) fragment into multiple iMessages. The latest stable is `1.61.0` (= the installed version); only alphas follow, and none adds native channel suspend-question rendering.

Industry chatbot-UX guidance favors natural turn-taking and concise single replies on messaging channels; interactive quick-reply buttons are unavailable on iMessage, and fragmented multi-bubble answers read as noise. The cleanest interaction on a linear text surface is a plain question followed by a plain reply.

## Decision

- Jamis asks the operator in plain text. When a request is missing information or is ambiguous in a way that changes what Jamis would do, Jamis asks directly in its reply, waits for the next message, and may re-ask while the answer is still ambiguous. This is the "check" in the project glossary: a clarifying question Jamis pauses to ask, answered by the operator's next message on the continuous thread (see [ADR 0010](0010-keep-imessage-conversations-continuous.md)).
- Do not wire `askUserTool`, `autoResumeSuspendedTools`, `requireApproval`, a `ToolDisplayFn`, or `streaming: true` on the Sendblue adapter in this slice. The adapter keeps `toolDisplay: 'hidden'` so delegations stay quiet, and replies post once per step (no streaming fragmentation).
- The confirmation facet (ask before a consequential or irreversible action) is policy-only this slice, stated as an instruction; Jamis has no write tool today, so nothing is gated.
- Defer the Mastra suspend/approval mechanism to a future channel that can render interactive elements (e.g., Slack/Teams cards), or to a stable that renders an `ask_user` suspend question natively on text channels. Revisit this ADR then.

The implementation lives in Jamis's coordination instructions only; see [plan 008](../plans/008-jamis-hitl.md).

## Alternatives not taken

- **`askUserTool` + `autoResumeSuspendedTools` + a `ToolDisplayFn` under `streaming: true` (the original Stage 2 design).** It renders the full question cleanly and gives a structured suspend/resume, but forcing `streaming: true` on Sendblue fragments multi-paragraph replies into separate iMessages because the adapter cannot post-and-edit. Auto-resume is also a new run rather than a true resume (the parked run lingers in `suspended-runs`), and stale suspended runs accumulate. The cost to the operator UX outweighs the structural benefit on a text-only channel today.
- **`askUserTool` with `toolDisplay: 'text'` (static, no streaming).** Avoids fragmentation but renders the ask only as a ~35-character truncated tool header that exposes the tool name, and turns on tool-chatter for every delegation, violating Jamis's "do not narrate routing, tool calls, or internal agent names" instruction.
- **`requireApproval` cards.** Render as cards that the Sendblue adapter drops silently, so a sensitive tool would park with no way to answer on iMessage.
- **A custom suspend tool.** Faces the same missing channel rendering with none of `askUserTool`'s built-in handling.

## Consequences

- The operator's HITL experience on iMessage is uniform: a plain question and a plain reply, one bubble per reply, no fragmentation and no tool chatter. The same interaction reads cleanly in Studio and on any future channel without per-surface rendering.
- "Ask until clear" relies on the continuous iMessage thread and Observational Memory ([ADR 0010](0010-keep-imessage-conversations-continuous.md)) across runs rather than a paused suspended run. There is no structured resume; an answer that does not address the question simply lets Jamis ask again.
- No new code controls are added: `toolDisplay`, `streaming`, `maxSteps`, `autoResumeSuspendedTools`, and `toolCallConcurrency` are unchanged. Behavior is instruction-driven and verified through real-model and channel smokes, not a hard code invariant.
- Future action tools (todos, tasking, planning) may reintroduce a structured confirmation mechanism when they land; that decision records its own ADR against this one and against the first button-capable channel or stable that renders suspend natively.
