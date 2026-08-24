# 008: Jamis human-in-the-loop as plain-text asks on iMessage

Status: **In progress. Stages 1 and 2 are complete; production rollout remains.**

On the current Sendblue shared line, Jamis asks a plain clarifying question when a request is ambiguous or missing information that changes what it would do. It may re-ask while the answer remains ambiguous. It does not use `askUserTool`, `requireApproval`, or `streaming` on this integration. Confirmation and approval for actions are out of scope because Jamis has no write tool. Todos, tasking, and planning belong to a later plan.

This branch began from `main` at `56628d4`. Review found that the original `askUserTool` + `ToolDisplayFn` + `streaming` design fragments replies on Sendblue. The corrected mechanism is recorded below and in [ADR 0012](../adrs/0012-jamis-hitl-as-text-checks.md).

## Decisions

- **Ask in plain text.** A missing-information or change-the-outcome ambiguity makes Jamis ask the operator directly in its reply, then wait. It may re-ask while the answer is still ambiguous. No tool, no suspend.
- **Keep the Sendblue adapter as `toolDisplay: 'hidden'`** with no `streaming`. Replies post once per step; delegations stay quiet; no `UserTool` results on the channel. No fragmentation, no tool chatter.
- **Defer confirmation.** This slice defines clarification only. The first write tool needs its own ADR and an enforceable confirmation boundary.
- **Defer structured prompts.** `askUserTool`, `autoResumeSuspendedTools`, `requireApproval`, `ToolDisplayFn`, and `streaming` are not used this slice. Revisit them only when a button-capable channel lands, Mastra renders an `ask_user` suspend question natively on this text channel without streaming, or a separate proposal integrates Sendblue App Cards on a V2 Mac line.
- **Keep tuning unchanged.** `maxSteps`, `autoResumeSuspendedTools`, and `toolCallConcurrency` are not modified; no suspend tool is registered, so the default concurrency is unaffected.

The durable reasoning is in [ADR 0012](../adrs/0012-jamis-hitl-as-text-checks.md).

### Research basis

Research used the installed Mastra packages, Mastra's own docs, the Sendblue adapter source, and primary agent/chatbot-UX guidance before this plan was rewritten.

| Fact | Consequence |
| :--- | :--- |
| The `ToolDisplayEvent` union on a channel is only `running \| result \| error \| approval`; the host never handles `tool-call-suspended` (`channels/types.d.ts:124-168`) | A suspended `ask_user` question is not auto-rendered on any channel; it can only surface indirectly via the `running` event fired before suspension |
| A `ToolDisplayFn` receives the `running` event only under the streaming driver; the static driver skips it (`agent-DSxJoGjY.js:19235-19238`) | Rendering the full question via a `ToolDisplayFn` requires `streaming: true` |
| `streaming: true` "requires the underlying adapter to support post-and-edit streaming" (Channels reference); Sendblue's `editMessage` throws, its `stream()` posts every `\n\n` segment separately, and it drops Chat SDK cards (`chat-adapter-sendblue/dist/index.js:246-263`) | `requireApproval` is unusable, and forcing streaming fragments multi-paragraph replies (research answers with a `Sources:` block) into separate iMessages |
| Sendblue [App Cards](https://docs.sendblue.com/api/resources/messages/methods/send) require a V2 Mac line, paid plan, compatible recipient extension, and separate adapter integration | The current shared line has no structured-card fallback. A deliberate App Card integration is a future graduation path, not work in this slice |
| The installed `@mastra/core@1.61.0` does not render a suspended `ask_user` question as a channel event | The mechanism is deferred until a release changes that installed behavior or a channel can render it |

## Public interface changes

- No public API or runtime interface is added. The existing coordination instruction in `src/mastra/agents/jamis.ts` is the only runtime change in this branch.
- The Sendblue webhook path, Cloudflare Access boundary, `onDirectMessage` allowlist, `toolDisplay`, `streaming`, `maxSteps`, and runtime tools list remain unchanged.

## Stage 1: record the HITL capability and boundary

**Status.** Corrected in this branch.

**Goal.** Capture the clarification-only mechanism, the current Sendblue boundary, and the deferred structured-prompt decision before behavioral verification.

**Critical files.** `CONTEXT.md`, `docs/adrs/0012-jamis-hitl-as-text-checks.md`, this plan.

The **Check** glossary term and ADR 0012 define clarification rather than confirmation. They scope the no-card conclusion to the current shared line and `chat-adapter-sendblue@0.2.0`, record Sendblue App Cards as a separate V2 Mac integration path, and retain the reasons the original suspend design was rejected.

**Verify.** Documentation links resolve, terminology matches `CONTEXT.md`, runtime code is unchanged, and `git diff --check` passes.

**Proposed commit.** `docs: correct Jamis check boundaries`

**PR metadata.** PR #18 is titled `feat: add Jamis plain-text checks` and its description reflects the corrected scope and stage status.

## Stage 2: add the ask instruction and verify behavior

**Status.** Implementation and local behavioral verification complete 2026-08-24 UTC.

**Goal.** Jamis asks the operator in plain text exactly when the policy says to, and does not ask when the request is unambiguous.

**Critical files.** `src/mastra/agents/jamis.ts`.

The coordination contract now says to ask directly rather than guess or stop when information is missing or ambiguity changes what Jamis would do, and to re-ask while it remains ambiguous. The existing weather-with-no-location instruction remains unchanged.

Do not add `askUserTool`, `autoResumeSuspendedTools`, `requireApproval`, a `ToolDisplayFn`, `streaming`, or any `maxSteps` change.

**Verify.**

1. `bun run typecheck`, `bun run lint`, and `bun run build` pass.
2. With the existing `.env`, running Postgres and ClickHouse, and a local authenticated Mastra server, confirm `agent list` returns only `jamis` and `tool list` has no `ask_user`.
3. Run the following real-model matrix through authenticated Jamis calls. Use a separate unique thread for each row. Every arrow in a row reuses that row's thread.

   | Scenario | Same-thread messages | Expected |
   | :--- | :--- | :--- |
   | Weather | `What's the weather?` → `Chicago` | First reply asks for a location without delegation or tool chatter. Second reply gives Chicago weather through `weatherAgent`. |
   | Re-ask | `Prepare either a customer announcement or internal rollout note.` → `Make it concise.` → `Write the internal rollout note in three sentences.` → `The internal rollout is a 2026-09-09 SSO migration. Staff must test their account by 2026-09-08. No customer announcement. Write the internal rollout note in three sentences.` | Jamis asks which output is intended, re-asks while the subject remains unclear, then writes only the requested rollout note after concrete details arrive. |
   | Direct | `Give me a one-line pep talk.` | A direct one-line reply, with no question or delegation. |
   | Research | `Research Mastra's automatic tool resumption and cite current documentation.` | Delegation to `researchAgent`, ADR 0011 citation contract, and one final reply. |
   | Generic deployment advice | `Give a generic, hypothetical deployment checklist for an unknown service. Clearly label assumptions and do not claim it describes Jamis.` | A direct, explicitly hypothetical checklist is acceptable. It must not state or imply that its assumptions describe Jamis. |
   | Jamis-specific deployment | `Give deployment instructions for Jamis. I have not provided its target, environment, branch, or rollback plan. Do not assume or invent them.` | Jamis asks for the missing details before giving executable or service-specific instructions. |

4. Record the UTC timestamp, thread ID, trace ID, model and effort, response, delegation, and re-ask count for every row. Confirm no `ask_user` span or suspended run exists; for research, confirm the [ADR 0011](../adrs/0011-jamis-online-research.md) citation contract.
5. Run `git diff --check`. The unchanged `bun run test` placeholder remains excluded because it exits with `Error: no test specified`.

Any failed row blocks Stage 3. Report the evidence only; do not tune the prompt during verification.

### Local results

Trace start window: 2026-08-24T03:10:12.241Z to 2026-08-24T03:18:54.053Z. The local server used `gpt-5.6-terra` with `reasoningEffort: 'max'` for Jamis.

| Scenario | Thread | Trace IDs | Result |
| :--- | :--- | :--- | :--- |
| Weather | `hitl-stage2-weather-20260824` | `0d7a43149e5496cb0c316bb72037e2c3`, `b14b3460c123a4bc3f8767d03421b44d` | Asked `Where?` with no tool, then delegated only to `weatherAgent` after `Chicago`. |
| Re-ask | `hitl-stage2-reask-20260824` | `b9bf81f601b0e374ebc9ce55b3dc0a9f`, `12939f519545c7fd82f55463341f4a61`, `c66e81180da10d6bf6890c2976ba0743`, `f0375a8db4c3e4622ad9bfed88e768f7` | Asked, then re-asked twice while details remained ambiguous, and produced the specified three-sentence internal note after the final concrete message. |
| Direct | `hitl-stage2-direct-20260824` | `ebcb9c947c432d1f231ae5347eabe9dc` | Direct one-line reply with no tool. |
| Research | `hitl-stage2-research-20260824` | `1746d73b76b13cffb70c69fc720ba180` | Delegated to `researchAgent`, used `firecrawlSearch` plus three `firecrawlScrape` calls, and returned citations matching ADR 0011. |
| Generic deployment advice | `hitl-stage2-ab-generic-20260824` | `8cc9b50c81c612ca025a2d43e11fa4f7` | Returned a checklist explicitly labelled hypothetical and not about Jamis. |
| Jamis-specific deployment | `hitl-stage2-ab-specific-20260824` | `9945ef7c7911a941f24809c42c70da0c` | Asked for target, environment, branch, rollback plan, deployment method, and approval window. |

The authenticated inventory returned only `jamis` and no `ask_user` tool. The recorded agent responses and detailed research trace contain no `ask_user` or suspended-tool event. The local API verifies one final text response; Stage 3 still verifies handset bubble count and Sendblue fragmentation.

**Proposed commit.** `docs: record Jamis check verification`

## Stage 3: roll out to iMessage and smoke the channel

**Status.** Not started.

**Goal.** Production Jamis asks cleanly over the current Sendblue line, re-asks when the reply is ambiguous, and posts one unfragmented text reply for every path while all existing security and channel boundaries stay intact.

**Critical files.** This plan, and ADR 0012 only if the rollout reveals a durable correction.

1. Before deployment, record the current production SHA and target remote SHA. Confirm this branch changes no secrets, webhook, Cloudflare, database, or volume configuration.
2. After separate commit and push approval, push `feat/jamis-hitl-checks`, verify the remote resolves to the approved local SHA, then deploy with `JAMIS_BRANCH=feat/jamis-hitl-checks infra/deploy.sh`.
3. Run one handset scenario at a time. For each chain, keep the follow-up messages in the same iMessage thread. When an operator response is needed, send one message and wait for its result before continuing.

   | Scenario | Same-thread messages | Expected |
   | :--- | :--- | :--- |
   | Weather | `What's the weather?` → `Chicago` | A location question, then Chicago weather. |
   | Re-ask | `Prepare either a customer announcement or internal rollout note.` → `Make it concise.` → `Write the internal rollout note in three sentences.` → `The internal rollout is a 2026-09-09 SSO migration. Staff must test their account by 2026-09-08. No customer announcement. Write the internal rollout note in three sentences.` | Focused clarification and re-asks, then the requested final note after concrete details. |
   | Direct | `Give me a one-line pep talk.` | Direct reply with no question. |
   | Research | `Research Mastra's automatic tool resumption and cite current documentation.` | Cited research reply with the `Sources:` block in the same message. |
   | Jamis-specific deployment | `Give deployment instructions for Jamis. I have not provided its target, environment, branch, or rollback plan. Do not assume or invent them.` | A clarification before executable or service-specific instructions. |

   Every reply must have no tool name, delegation narration, fragmentation, or App Card.

4. Inspect ClickHouse traces and Postgres messages for the ask, re-ask, research, and direct paths. Confirm no `ask_user` tool or suspended run exists, and that `SENDBLUE_*` and other secrets are absent.
5. Confirm authenticated `agent list` still returns only `jamis`, the Sendblue webhook and Cloudflare Access are unchanged, and authenticated endpoints reject an invalid bearer token.
6. Record UTC results, thread IDs, trace IDs, and production SHA in this plan. Then run `bun run typecheck`, `bun run lint`, `bun run build`, and `git diff --check`. `bun run test` remains excluded because its unchanged placeholder script exits with `Error: no test specified`, as documented in plan 006.

Any failed smoke blocks further rollout. Report the evidence only; do not tune the prompt during rollout.

**Rollback.** Make a focused rollback commit that removes only the clarification instruction, obtain separate approval to push, verify the remote branch SHA, and rerun `infra/deploy.sh`. Do not change storage, webhooks, or documentation history as part of rollback.

**Proposed commit.** `docs: record Jamis check rollout`

## Acceptance

| # | Check |
| :---: | :--- |
| 1 | Jamis remains the only public Mastra agent |
| 2 | A missing-information or change-the-outcome ambiguity that prevents a service-specific answer makes Jamis ask the operator in plain text; confirmation is not part of this slice |
| 3 | The reply is a single message (no fragmentation, no streaming) and contains no tool name or delegation chatter |
| 4 | An ambiguous answer triggers a re-ask on the same continuous thread, and the final action reflects only the last clear answer |
| 5 | Unambiguous requests never trigger a question; explicitly hypothetical generic advice may reply directly, while missing-context Jamis-specific instructions ask before executable advice; researched answers still obey the citation contract |
| 6 | No `askUserTool`, `requireApproval`, `autoResumeSuspendedTools`, `ToolDisplayFn`, or `streaming` is used; `tool list` does not include `ask_user` |
| 7 | After asks, no suspended runs accumulate in `suspended-runs` (none were created) |
| 8 | All smoke tests pass against the current Sendblue line, and authenticated endpoints reject unauthenticated requests |

## Tuning and graduation

Keep the policy as instructions and review changes through Git. Do not change the wording in response to a failed verification or rollout row.

1. Start with the plain-text ask policy and the existing `maxSteps: 5`.
2. If observed production use shows too many trivial questions, propose a narrow instruction change that preserves the outcome-changing threshold.
3. The first write tool needs its own ADR and enforcement design. Do not infer a confirmation policy from this clarification instruction.
4. Revisit structured prompts only when a button-capable channel lands, Mastra renders an `ask_user` suspend question natively on the current text channel without streaming, or a separately proposed V2 Mac Sendblue App Card integration is complete.

## Out of scope

- `askUserTool`, `autoResumeSuspendedTools`, `requireApproval`, `submitPlanTool`, task tools, or a `ToolDisplayFn` this slice
- `streaming` on the Sendblue adapter or any rendering code
- Todos, tasking, planning, or any action/write tool and its confirmation path (separate plans)
- A buttoned or web-based approval UI, Studio-based approval, or any off-channel surface
- Sendblue App Cards, a V2 Mac line, recipient extension work, or paid-plan changes
- A code-enforced "must ask" detector or rules engine
- Model changes, model fallbacks, or a casual-versus-verification router
- Any change to the Sendblue webhook, Cloudflare Access, or the operator allowlist

## Execution rhythm

Each repository stage is independently committable. After implementing a stage, run its verification, show the diff summary and proposed commit message, and wait for explicit approval before committing. Approval to commit is not approval to push; pushing requires separate confirmation.
