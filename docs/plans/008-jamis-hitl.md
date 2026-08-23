# 008: Jamis human-in-the-loop as plain-text asks on iMessage

Status: **Planned 2026-08-23 UTC. Revised after review.**

Jamis performs human-in-the-loop on iMessage as a plain conversational ask: when a request is ambiguous or missing information that changes what Jamis would do, it asks directly in its reply, waits for the next message, and may re-ask while the answer is still ambiguous. It does not use `askUserTool`, `requireApproval`, or `streaming` on iMessage this slice. Todos, tasking, and planning are out of scope and belong to a later plan.

Planned from `main` at `56628d4`. Review (subagents + own pass) found the original `askUserTool` + `ToolDisplayFn` + `streaming` design fragments replies on Sendblue; the corrected mechanism is recorded below and in [ADR 0012](../adrs/0012-jamis-hitl-as-text-checks.md).

## Decisions

- **Ask in plain text.** A missing-information or change-the-outcome ambiguity makes Jamis ask the operator directly in its reply, then wait. It may re-ask while the answer is still ambiguous. No tool, no suspend.
- **Keep the Sendblue adapter as `toolDisplay: 'hidden'`** with no `streaming`. Replies post once per step; delegations stay quiet; no `UserTool` results on the channel. No fragmentation, no tool chatter.
- **Confirmation-before-action is policy-only.** Jamis has no write tool today, so the "ask before consequential action" clause is an instruction with nothing to gate; it lands as a real check when the first action tool arrives (separate plan + ADR).
- **Defer the Mastra suspend/approval mechanism.** `askUserTool`, `autoResumeSuspendedTools`, `requireApproval`, `ToolDisplayFn`, and `streaming` are not used this slice. They return when a button-capable channel (Slack/Teams) lands, or a stable renders an `ask_user` suspend question natively on text channels.
- **Keep tuning unchanged.** `maxSteps`, `autoResumeSuspendedTools`, and `toolCallConcurrency` are not modified; no suspend tool is registered, so the default concurrency is unaffected.

The durable reasoning is in [ADR 0012](../adrs/0012-jamis-hitl-as-text-checks.md).

### Research basis

Research used the installed Mastra packages, Mastra's own docs, the Sendblue adapter source, and primary agent/chatbot-UX guidance before this plan was rewritten.

| Fact | Consequence |
| :--- | :--- |
| The `ToolDisplayEvent` union on a channel is only `running \| result \| error \| approval`; the host never handles `tool-call-suspended` (`channels/types.d.ts:124-168`) | A suspended `ask_user` question is not auto-rendered on any channel; it can only surface indirectly via the `running` event fired before suspension |
| A `ToolDisplayFn` receives the `running` event only under the streaming driver; the static driver skips it (`agent-DSxJoGjY.js:19235-19238`) | Rendering the full question via a `ToolDisplayFn` requires `streaming: true` |
| `streaming: true` "requires the underlying adapter to support post-and-edit streaming" (Channels reference); Sendblue's `editMessage` throws and its `stream()` posts every `\n\n` segment separately (`chat-adapter-sendblue/dist/index.js:246-263`) | Forcing streaming on iMessage fragments multi-paragraph replies (research answers with a `Sources:` block) into separate iMessages |
| `requireApproval` renders interactive cards; iMessage has no cards ("iMessage has no interactive cards for Approve and Deny actions", Mastra's iMessage integration) and Sendblue drops them | Approval cards are unusable on iMessage |
| Industry chatbot UX favors natural turn-taking and concise single replies on messaging channels; quick-reply buttons are unavailable on iMessage | A plain conversational question + reply is the lowest-friction, channel-uniform interaction |
| Latest stable `@mastra/core` is `1.61.0` (the installed version); only alphas follow, with no native channel suspend-question rendering | There is no newer stable to adopt for suspend rendering; the mechanism is deferred, not waited on |

## Public interface changes

- None new. The Sendblue webhook path, Cloudflare Access boundary, `onDirectMessage` allowlist, `toolDisplay`, `streaming`, `maxSteps`, and the runtime tools list are all unchanged. Jamis gains one coordination instruction bullet.

## Stage 1: record the HITL capability and boundary

**Status.** Complete 2026-08-23 UTC (PR #18 — docs only).

**Goal.** Capture the plain-text ask mechanism, the deferred suspend/approval decision, and the confirmation policy-only boundary before any remaining verification.

**Critical files.** `CONTEXT.md`, `docs/adrs/0012-jamis-hitl-as-text-checks.md`, this plan.

The **Check** glossary term and ADR 0012 record why iMessage HITL is a plain conversational ask, why the built-in suspend/approval mechanism is deferred, and why the confirmation facet is policy-only until a write tool exists.

**Verify.** Documentation links resolve, terminology matches `CONTEXT.md`, and `git diff --cached --check` passes.

**Proposed commit.** `docs: define Jamis human-in-the-loop checks`

## Stage 2: add the ask instruction and verify behavior

**Status.** Not started.

**Goal.** Jamis asks the operator in plain text exactly when the policy says to, and does not ask when the request is unambiguous.

**Critical files.** `src/mastra/agents/jamis.ts`.

Add one instruction bullet to Jamis's coordination contract: if a request is missing information or is ambiguous in a way that changes what Jamis would do, ask the operator directly and wait for the answer instead of guessing or stopping; re-ask while still ambiguous. Reuse the existing "weather with no location" line unchanged.

Do not add `askUserTool`, `autoResumeSuspendedTools`, `requireApproval`, a `ToolDisplayFn`, `streaming`, or any `maxSteps` change.

**Verify.**

1. `bun run typecheck`, `bun run lint`, and `bun run build` pass.
2. `bun run --bun mastra api --url http://127.0.0.1:4111 --header 'Authorization: Bearer <API_TOKEN>' agent list` still returns only `jamis`; `tool list` no longer includes `ask_user` (it is not registered).
3. Real-model matrix through authenticated Jamis calls (Studio or `agent run`), one thread each:

   | Prompt class | Expected |
   | :--- | :--- |
   | Weather with no location | A single reply asking for the location, no delegation, no tool chatter |
   | Follow-up with a clear city | Weather for that city through `weather-agent`, one reply |
   | Genuinely ambiguous request with two different outcomes | Jamis asks which, without acting on either |
   | Follow-up with a still-ambiguous answer | Jamis asks again with a tighter question |
   | Casual unambiguous conversation | Direct reply, no question |
   | Explicit research request with enough context | Delegates to `research-agent`; answer follows the citation contract, single reply |
   | A request to guess instead of asking | Jamis asks (or refuses), model confidence ignored |

4. For each researched response confirm no `ask_user` span appears (no tool), the reply is a single message (no fragmentation), and citations follow [ADR 0011](../adrs/0011-jamis-online-research.md).
5. `git diff --check` passes.

**Proposed commit.** `feat: ask the operator for clarifying input`

## Stage 3: roll out to iMessage and smoke the channel

**Status.** Not started.

**Goal.** Production Jamis asks cleanly over iMessage, re-asks when the reply is ambiguous, and posts single, non-fragmented replies for every path while all existing security and channel boundaries stay intact.

**Critical files.** This plan, and ADR 0012 only if the rollout reveals a durable correction.

1. After separate push approval, confirm the approved commits are present on the deployment branch, push, verify `origin/<deployment-branch>` resolves to the approved local SHA, record that production SHA, and deploy through `infra/deploy.sh`. No `.env.prod` secret changes are required.
2. Send a weather request with no location. Expected: one plain-text question asking for the location, no delegation chatter, no tool name.
3. Reply with a city. Expected: the weather for that city in the same thread.
4. Send a genuinely ambiguous request. Expected: one focused question, no action; reply partially, then confirm Jamis re-asks rather than guessing.
5. Send an ordinary message. Expected: a direct reply, no question, one bubble.
6. Send a verification-required request. Expected: research with citations, one reply (the `Sources:` block stays in the same message, not a second bubble).
7. Inspect ClickHouse traces and Postgres messages for the ask, re-ask, research, and direct paths. Confirm `SENDBLUE_*` and other secrets are absent, and no internal tool names or routing leaked into replies. Confirm no `ask_user` tool was invoked and no suspended runs exist (no `suspended-runs` accumulation).
8. Confirm authenticated `agent list` returns only `jamis`; the Sendblue webhook is unchanged; Cloudflare Access is unchanged; and authenticated endpoints reject requests without a valid bearer token.
9. Record UTC results and the production SHA in this plan, then rerun `bun run typecheck`, `bun run lint`, `bun run build`, and `git diff --check`. `bun run test` remains excluded because its unchanged placeholder script exits with `Error: no test specified`, as documented in plan 006.

**Rollback.** Revert the instruction commit, obtain separate approval to push, verify the remote branch SHA, and rerun `infra/deploy.sh`. No database or webhook rollback is required.

**Proposed commit.** `docs: record HITL rollout`

## Acceptance

| # | Check |
| :---: | :--- |
| 1 | Jamis remains the only public Mastra agent |
| 2 | A missing-information or change-the-outcome ambiguity makes Jamis ask the operator in plain text and wait |
| 3 | The reply is a single message (no fragmentation, no streaming) and contains no tool name or delegation chatter |
| 4 | An ambiguous answer triggers a re-ask on the same continuous thread, and the final action reflects only the last clear answer |
| 5 | Unambiguous requests never trigger a question; researched answers still obey the citation contract |
| 6 | No `askUserTool`, `requireApproval`, `autoResumeSuspendedTools`, `ToolDisplayFn`, or `streaming` is used; `tool list` does not include `ask_user` |
| 7 | After asks, no suspended runs accumulate in `suspended-runs` (none were created) |
| 8 | All smoke tests pass against the real Sendblue line, and authenticated endpoints reject unauthenticated requests |

## Tuning and graduation

Keep the policy as instructions and review changes through Git.

1. Start with the plain-text ask policy and the existing `maxSteps: 5`.
2. If Jamis asks too often on trivial messages, tighten the instruction to ask only when a clarification would change the outcome.
3. If Jamis acts on consequential steps without asking, strengthen the instruction; once a write tool exists, revisit whether that tool needs a structured confirmation (its own ADR).
4. Revisit this decision when a button-capable channel lands or a stable renders an `ask_user` suspend question natively; then `askUserTool`/`requireApproval` can return with native rendering and no fragmentation.

## Out of scope

- `askUserTool`, `autoResumeSuspendedTools`, `requireApproval`, `submitPlanTool`, task tools, or a `ToolDisplayFn` this slice
- `streaming` on the Sendblue adapter or any rendering code
- Todos, tasking, planning, or any action/write tool and its confirmation path (separate plans)
- A buttoned or web-based approval UI, Studio-based approval, or any off-channel surface
- A code-enforced "must ask" detector or rules engine
- Model changes, model fallbacks, or a casual-versus-verification router
- Any change to the Sendblue webhook, Cloudflare Access, or the operator allowlist

## Execution rhythm

Each repository stage is independently committable. After implementing a stage, run its verification, show the diff summary and proposed commit message, and wait for explicit approval before committing. Approval to commit is not approval to push; pushing requires separate confirmation.
