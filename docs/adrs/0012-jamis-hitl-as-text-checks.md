# Jamis asks the operator in plain text on iMessage

On the current Sendblue shared line, Jamis treats human-in-the-loop as a plain conversational clarification: when a request is ambiguous or missing information that changes what Jamis would do, it asks the operator directly in its reply, and may re-ask while the answer is still ambiguous. This ADR does not define confirmation or approval for actions. Jamis does not use Mastra's `askUserTool` suspend mechanism or `requireApproval` approval cards on this integration. Those mechanisms are deferred until a suitable channel or a native text-channel rendering path exists.

## Context

Jamis currently reaches iMessage through a shared Sendblue line and `chat-adapter-sendblue@0.2.0`. The adapter converts markdown to plain text, renders only text-oriented outbound payloads, does not expose Chat SDK cards, and its `editMessage` throws. Mastra's own iMessage integration guidance sets `toolDisplay: 'text'` and notes that iMessage has no interactive cards for Approve and Deny actions.

Sendblue separately offers [App Cards](https://docs.sendblue.com/api/resources/messages/methods/send). They require a V2 Mac line, a paid Sendblue plan, and a recipient with the compatible Messages extension, and use a distinct [update endpoint](https://docs.sendblue.com/api/resources/messages/methods/update_app_card). The current shared line does not use that product, and the current adapter does not integrate it. The limitation in this ADR is therefore the current line and adapter, not a claim that iMessage can never show interactive content.

Mastra offers two HITL primitives: `requireApproval` (pre-execution Approve/Deny card) and `askUserTool` (a built-in `suspend()` that asks a question and returns the answer as the tool result). Both are designed to render through a host that can show interactive prompts. On the installed `@mastra/core@1.61.0`, the suspend question is **not a renderable channel event**: the `ToolDisplayEvent` union is only `running | result | error | approval`, and the channel host never handles `tool-call-suspended`. Surfacing the question through a `ToolDisplayFn` requires capturing the `running` event that fires *before* suspension, which the static driver skips and only the streaming driver dispatches. But `streaming: true` "requires the underlying adapter to support post-and-edit streaming," and Sendblue cannot edit: its `stream()` posts every `\n\n`-delimited segment as a separate message, so multi-paragraph replies (research answers with a `Sources:` block) fragment into multiple iMessages. Reconsider this ADR during a Mastra upgrade only if that installed channel behavior changes.

A plain question followed by a plain reply is the smallest interaction that preserves a single final message on the current channel.

## Decision

- Jamis asks the operator in plain text only for missing information or ambiguity that changes what it would do. It may re-ask while the answer remains ambiguous. This is the "check" in the project glossary: a clarifying question answered by the operator's next message on the continuous thread (see [ADR 0010](0010-keep-imessage-conversations-continuous.md)).
- Do not wire `askUserTool`, `autoResumeSuspendedTools`, `requireApproval`, a `ToolDisplayFn`, or `streaming: true` on the Sendblue adapter in this slice. The adapter keeps `toolDisplay: 'hidden'` so delegations stay quiet, and replies post once per step (no streaming fragmentation).
- Confirmation is out of scope. Jamis has no write tool today. The first write tool needs its own ADR that chooses an enforceable confirmation boundary.
- Revisit the structured mechanism only when one of these conditions holds: a channel with interactive controls is added, Mastra renders suspended `ask_user` questions natively on this text channel without streaming, or a separate proposal integrates Sendblue App Cards on a V2 Mac line. App Cards are not a fallback inside this slice.

The implementation lives in Jamis's coordination instructions only; see [plan 008](../plans/008-jamis-hitl.md).

## Alternatives not taken

- **`askUserTool` + `autoResumeSuspendedTools` + a `ToolDisplayFn` under `streaming: true` (the original Stage 2 design).** It renders the full question cleanly and gives a structured suspend/resume, but forcing `streaming: true` on Sendblue fragments multi-paragraph replies into separate iMessages because the adapter cannot post-and-edit. Auto-resume is also a new run rather than a true resume (the parked run lingers in `suspended-runs`), and stale suspended runs accumulate. The cost to the operator UX outweighs the structural benefit on a text-only channel today.
- **`askUserTool` with `toolDisplay: 'text'` (static, no streaming).** Avoids fragmentation but renders the ask only as a ~35-character truncated tool header that exposes the tool name, and turns on tool-chatter for every delegation, violating Jamis's "do not narrate routing, tool calls, or internal agent names" instruction.
- **`requireApproval` cards.** The current Sendblue adapter drops Chat SDK card payloads, so a sensitive tool would park with no way to answer on this channel. Sendblue App Cards are a distinct vendor protocol with V2 Mac line, account, recipient, and adapter work, so they are not a fallback for this decision.
- **A custom suspend tool.** Faces the same missing channel rendering with none of `askUserTool`'s built-in handling.

## Consequences

- The operator's clarification experience on the current iMessage channel is a plain question and a plain reply, with no tool chatter or streaming fragmentation.
- "Ask until clear" relies on the continuous iMessage thread and Observational Memory ([ADR 0010](0010-keep-imessage-conversations-continuous.md)) across runs rather than a paused suspended run. There is no structured resume; an answer that does not address the question simply lets Jamis ask again.
- This is not an approval or safety control. No new code controls are added: `toolDisplay`, `streaming`, `maxSteps`, `autoResumeSuspendedTools`, and `toolCallConcurrency` are unchanged. Behavior is instruction-driven and verified through real-model and channel smokes, not a hard code invariant.
- A future action tool must record its own confirmation design. A future button-capable channel, native Mastra suspend rendering, or a deliberate Sendblue App Card integration can reopen the structured-prompt decision.
