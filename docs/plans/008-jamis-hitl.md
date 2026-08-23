# 008: Jamis human-in-the-loop through text checks

Status: **Planned 2026-08-23 UTC. Revised after review.**

Jamis gains human-in-the-loop as a built-in `askUserTool` "check": it pauses to ask the operator a clarifying question or get confirmation before acting, renders that question as plain text through a custom channel renderer, and acts on the operator's answer when their reply arrives. On iMessage this is a plain question and a reply, never an approve/deny card. Todos, tasking, and planning are out of scope and belong to a later plan.

Planned from `main` at `56628d4`. Review (independent subagent + own pass) found the original `toolDisplay` reasoning wrong in both directions; the corrected mechanism is recorded below and in [ADR 0012](../adrs/0012-jamis-hitl-as-text-checks.md).

## Decisions

- **Give Jamis the built-in `askUserTool`** (`ask_user`) from `@mastra/core/tools`. It is the single human-in-the-loop primitive for clarifying questions and confirmations in this slice.
- **Render the check with a `ToolDisplayFn`.** No string `toolDisplay` mode renders a suspended `ask_user` question in `@mastra/core@1.61.0`. Add a function-form `toolDisplay` that posts the full question (from the `running` event's `args.question`) and returns nothing for every other event, so delegations stay quiet.
- **Enable `streaming: true` on the Sendblue adapter.** `ToolDisplayFn` only receives the `running` event under the streaming driver; `resolveStreaming` defaults to disabled and the static driver skips the function on `tool-call`, so the renderer does nothing without it.
- **Set `defaultOptions.autoResumeSuspendedTools: true`.** The operator's next message on the same durable thread supplies the answer through auto-resume, which is a prompt-level re-invocation of the tool in a new run, not a resumption of the parked run. The parked run may linger in `suspended-runs`; its cleanup is verified, not assumed.
- **Add `toolCallConcurrency: { limit: 8, strategy: 'called' }`.** Registering a suspending tool otherwise forces every step's tool batch to run sequentially. The `'called'` strategy resolves concurrency from the tools the model actually invoked, preserving parallel delegation when `ask_user` is not the step calling.
- **Raise `defaultOptions.maxSteps` from five to eight.** The re-ask bound is per run, because each operator reply starts a fresh run; it is not cumulative across replies.
- **Use a balanced ask policy.** Jamis checks before consequential or irreversible actions and whenever a clarification would change what it does; it otherwise acts, and may re-ask while the answer is ambiguous.
- **Put `askUserTool` on Jamis only.** Subagents do not ask; they return results and Jamis performs the check, preserving conversation ownership from [ADR 0009](../adrs/0009-jamis-as-mastra-supervisor.md).
- **Defer `requireApproval`, custom confirmation tools, and any buttoned surface.** Approval renders as a Card regardless of mode, and the Sendblue adapter drops cards silently, so it cannot work on iMessage. The confirmation facet is policy-only until a write tool exists; nothing is gated today.

The durable architectural reasoning is in [ADR 0012](../adrs/0012-jamis-hitl-as-text-checks.md).

### Research basis

Research used the installed Mastra packages, the Sendblue adapter source, Mastra's own docs, and the latest registry/changelog before this plan was written.

| Fact | Consequence |
| :--- | :--- |
| `@mastra/core@1.61.0` exports `askUserTool` (`ask_user`) from `@mastra/core/tools`; it suspends and returns the operator's answer as the tool result | One built-in tool, no new dependency |
| No channel driver handles the `tool-call-suspended` chunk; the tool-event renderer covers only `running`, `result`, `error`, `approval` | No string `toolDisplay` mode surfaces the suspended question; a custom renderer is required |
| `ToolDisplayFn` receives a `running` event carrying full `args` (`channels/types.d.ts:124-168`), but only under the streaming driver (`agent-DSxJoGjY.js:19708-19719`); the static driver skips it (`19137-19140`) and `resolveStreaming` defaults to disabled (`21470-21472`) | The renderer must pair with `streaming: true` |
| `autoResumeSuspendedTools` is a supported `defaultOptions` key (`agent/types.d.ts:618`, `agent/agent.types.d.ts:594`); it adds a system-prompt suffix that re-invokes the suspended tool with `resumeData` in a new run | Resume is a new run, not a continuation of the parked one; re-ask budget is per run |
| Registering a suspending tool forces every step's tool batch to serialize (`agent/agent.types.d.ts:596-600`); the opt-in `toolCallConcurrency` strategy `'called'` resolves from the tools actually called (`loop/types.d.ts:36-51`) | Add `toolCallConcurrency: { limit: 8, strategy: 'called' }` to preserve parallel delegation |
| `requireApproval` renders `useCards = true` regardless of mode (`agent-DSxJoGjY.js:19088`); Sendblue's `renderOutbound` returns `""` for a card and `postMessage` skips empty messages | `requireApproval` is unusable on Sendblue, not merely unpresentable |
| Sendblue strips markdown to plain text; buttons, cards, select menus, and modals are unsupported, only tapbacks exist | Confirmations are textual questions |
| `GET /agents/:id/suspended-runs` and `POST /agents/:id/resume-stream` are `requiresAuth` and take `{ runId, resumeData }` (`server/handlers/agents.js:1757,1842`) | The suspend/resume round-trip is testable without the live channel |
| `mastra api agent` exposes only `list`, `get`, `run` (run maps to the generate endpoint) | Stage 2 resume smoke uses `curl`, not a resume CLI subcommand |
| Latest stable `@mastra/core` is `1.61.0`; only `1.61.1-alpha`, `1.62.0-alpha` follow, with no channel suspend-question rendering | There is no newer stable to adopt; the renderer must be authored, with a note to revisit if a stable ships native rendering |

## Public interface changes

- Authenticated `GET /api/agents/jamis/suspended-runs` and `POST /api/agents/jamis/resume-stream` become the operator-facing way to inspect and resume a paused check. Both were already registered and remain `requiresAuth`.
- After Jamis resolves `askUserTool`, authenticated `/api/tools` lists the intrinsic tool id `ask_user`; agent configuration and traces use the object key `askUserTool`.
- The Sendblue webhook path, Cloudflare Access boundary, and `onDirectMessage` allowlist are unchanged. `toolDisplay` becoming a function and `streaming: true` are config-internal and do not move any route.
- Jamis's `defaultOptions` gains `autoResumeSuspendedTools: true`, `toolCallConcurrency: { limit: 8, strategy: 'called' }`, and `maxSteps: 8`. `researchAgent` keeps its own `maxSteps: 5` and Firecrawl one-search-three-scrape budget.
- `POST /api/agents/jamis/approve-tool-call` and `/decline-tool-call` remain registered but unused because `requireApproval` is deferred.

## Stage 1: record the checks capability and boundary

**Status.** Not started.

**Goal.** Capture the HITL capability, the `askUserTool` choice, the `ToolDisplayFn` + streaming rendering decision, the new-run resume semantics, and the deferred `requireApproval` boundary before implementation depends on them.

**Critical files.** `CONTEXT.md`, new `docs/adrs/0012-jamis-hitl-as-text-checks.md`, this plan.

Add **Check** to the glossary in the Jamis/subagent group. ADR 0012 records why the check is the built-in `askUserTool`, why it must be rendered by a `ToolDisplayFn` under `streaming: true` rather than a string `toolDisplay` mode, why auto-resume is a new-run re-invocation, why `toolCallConcurrency` gets the `'called'` strategy, why only Jamis asks, why `requireApproval` is deferred, and why the confirmation facet is policy-only until a write tool exists.

**Verify.** All documentation links resolve, terminology matches `CONTEXT.md`, the ADR contains every decision bullet the plan references, and `git diff --cached --check` passes after staging only the three Stage 1 documentation files.

**Proposed commit.** `docs: define Jamis human-in-the-loop checks`

## Stage 2: wire the check primitive and prove suspend, resume, and auto-resume

**Status.** Not started.

**Goal.** Jamis can suspend a run to ask, resume by an explicit answer, and auto-resume on the next message, proven against the local server without the channel.

**Critical files.** `src/mastra/agents/jamis.ts`.

1. Import `askUserTool` from `@mastra/core/tools` and add `tools: { askUserTool }` to Jamis.
2. Add `autoResumeSuspendedTools: true`, `toolCallConcurrency: { limit: 8, strategy: 'called' }`, and `maxSteps: 8` to `defaultOptions`.
3. Replace the Sendblue `toolDisplay: 'hidden'` with a `ToolDisplayFn` that posts the full `ask_user` question on the `running` event and returns nothing otherwise, and add `streaming: true`:

   ```ts
   sendblue: {
     adapter: sendblueAdapter,
     toolDisplay: (event) => {
       if (event.kind === 'running' && event.toolName === 'ask_user') {
         const args = event.args as { question?: unknown } | undefined;
         if (args && typeof args.question === 'string' && args.question.trim()) {
           return { kind: 'post', message: args.question };
         }
       }
       return undefined;
     },
     streaming: true,
     gateway: false,
   },
   ```

4. Add the minimal check-routing instruction to Jamis: an ambiguous or missing-input request (including the existing "weather with no location" case) triggers `askUserTool` instead of a dead-end text reply. This instruction is required for the smoke below to produce a suspension.

Do not change subagents, the `delegation.messageFilter`, memory, the model, `onDirectMessage`, or `isOperator`. Do not add `requireApproval` or any custom tool.

**Verify.**

1. `bun run typecheck`, `bun run lint`, and `bun run build` pass.
2. Start the local server, replace `<API_TOKEN>` without printing or committing it, and confirm `bun run --bun mastra api --url http://127.0.0.1:4111 --header 'Authorization: Bearer <API_TOKEN>' agent list` still returns only `jamis`.
3. **Explicit suspend smoke.** Run Jamis with a weather request that has no location:

   ```sh
   bun run --bun mastra api --timeout 120000 --url http://127.0.0.1:4111 \
     --header 'Authorization: Bearer <API_TOKEN>' \
     agent run jamis '{"messages":"What is the weather?","memory":{"thread":"<THREAD_ID>","resource":"<RESOURCE_ID>"}}'
   ```

   Expected: a suspended result carrying a `runId` and a suspend payload with a question. Record the `runId`. If the exact top-level JSON differs on this version, recover run id and question from `toolCalls[].suspendPayload` via step 4.
4. **Suspended-run discovery.** Confirm the paused run is visible:

   ```sh
   curl -fsS -H "Authorization: Bearer <API_TOKEN>" \
     "http://127.0.0.1:4111/api/agents/jamis/suspended-runs?threadId=<THREAD_ID>&resourceId=<RESOURCE_ID>" | jq .
   ```

   Expected: one entry whose suspended tool call is `ask_user`, with `question` under `toolCalls[].suspendPayload` and `requiresApproval` false.
5. **Explicit resume smoke.** Resume and confirm the answer is consumed:

   ```sh
   curl -fsSN -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
     -X POST http://127.0.0.1:4111/api/agents/jamis/resume-stream \
     -d '{"runId":"<RUN_ID>","resumeData":"New York"}' | tee /tmp/jamis-resume.sse
   ```

   Expected: the streamed answer is current weather for New York through `weather-agent`, and it depends on "New York". Record the SSE body; do not leave the file under `/tmp` permanently.
6. **Auto-resume smoke (the mechanism the channel uses).** With a suspended check pending on `<THREAD_ID>`, start a second run on the same thread with no explicit resume data:

   ```sh
   bun run --bun mastra api --timeout 120000 --url http://127.0.0.1:4111 \
     --header 'Authorization: Bearer <API_TOKEN>' \
     agent run jamis '{"messages":"New York","memory":{"thread":"<THREAD_ID>","resource":"<RESOURCE_ID>"}}'
   ```

   Expected: Jamis re-invokes `ask_user` with the answer (a new run, not a continuation) and then delegates to `weather-agent` for New York. Confirm the trace shows a second run containing the `ask_user` re-invocation and the weather delegation, not a resumed version of the first run.
7. **Tool registration.** After the runs above, `bun run --bun mastra api --url http://127.0.0.1:4111 --header 'Authorization: Bearer <API_TOKEN>' tool list` includes the intrinsic id `ask_user`.
8. **Negative smoke.** A harmless greeting still answers directly with no `ask_user` span and no suspended run.
9. **Restart-recovery smoke.** Suspend a run, stop the local server, restart it, and repeat step 4: the suspended run must still be discoverable and resumable through the Postgres snapshot.
10. **Stale-run smoke.** After step 6's auto-resume, repeat step 4. Record whether the already-answered check still appears. The acceptance target is that a consumed check does not remain listed; if it lingers, record it as a known cleanup gap to resolve in Stage 4 rather than a silent failure.
11. `git diff --check` passes.

**Proposed commit.** `feat: add Jamis ask_user checks`

## Stage 3: apply the check policy and verify model behavior

**Status.** Not started.

**Goal.** Jamis checks exactly when the balanced policy says to, re-asks while intent is ambiguous, and carries the operator's answer through, verified with a real-model matrix.

**Critical files.** `src/mastra/agents/jamis.ts`.

Update Jamis's coordination contract:

- A request requiring clarification triggers a check through `askUserTool`. The existing "weather with no location" path routes through the check.
- Jamis checks before any consequential or irreversible action. Jamis has no write tool today, so this is a standing policy clause, not an implemented gate; it stays worded as policy.
- Jamis may re-ask while the answer is ambiguous, each re-ask on a fresh run. It treats the operator's reply as the answer to the pending question.
- A check question is not a factual claim: it never carries the `Sources:`/`[1]` contract, and a factual answer following a check still obeys the verification-required contract from [ADR 0011](../adrs/0011-jamis-online-research.md).
- Jamis never narrates the check mechanism or tool name unless asked.

**Keep the enforcement boundary explicit.** Tool wiring, the renderer, `autoResumeSuspendedTools`, `toolCallConcurrency`, and `maxSteps` are code controls. Whether Jamis actually checks, re-asks, or declines to guess is model-driven and verified through outputs and traces, not a hard code invariant. These are probabilistic instruction-following checks; a violation fails the rollout gate for this version, and stage tuning or a stronger enforcement decision would be a separate ADR and plan. Do not add a rules engine, a code-enforced "must ask" detector, or a second model.

**Verify.** Run a small real-model matrix through authenticated Jamis calls, using `agent run` then a second `agent run` on the same thread (not `resume-stream`) where a check is expected, so the matrix exercises the same auto-resume the channel uses:

| Prompt class | Expected behavior |
| :--- | :--- |
| Weather request with no location | Check: asks the location; does not delegate weather |
| Follow-up "New York" on the same thread | Acts on New York through `weather-agent` |
| Ambiguous request with two genuinely different plans | Check: asks which, without acting on either |
| Follow-up with a still-ambiguous answer | Check again with a tighter question (ask-until-clear) |
| Follow-up with a clear answer | Acts on that answer only, no third check |
| Casual unambiguous conversation | Direct answer, no check |
| Explicit research request with enough context | Delegates to `researchAgent`, no check; answer follows the citation contract |
| Verification-required claim with no ambiguity | Research path, no check |
| A request to guess instead of checking | Still checks (or refuses); model confidence ignored |

For the ask-until-clear row, confirm the re-ask happens on a new run on the same thread and the final action reflects only the last clear answer. For every checked row, record the trace ids of the ask run and the follow-up run. Confirm no check question emits a `Sources:` block, and a researched answer after a check still carries adjacent citations for its factual claims.

**Local verification.** Record UTC results, trace ids, the model and effort setting, and the observed re-ask count in this plan before Stage 4.

Re-run `bun run typecheck`, `bun run lint`, `bun run build`, and `git diff --check`.

**Proposed commit.** `feat: apply balanced check policy`

## Stage 4: roll out to iMessage and smoke the channel round-trip

**Status.** Not started.

**Goal.** Production Jamis renders the check as a full question over iMessage, resumes on the operator's reply, and re-asks when the reply does not answer, while every existing security and channel boundary stays intact.

**Critical files.** This plan, and ADR 0012 only if the rollout reveals a durable correction.

1. After separate push approval, confirm the approved commits are present on the deployment branch, push, verify `origin/<deployment-branch>` resolves to the approved local SHA, record that SHA, and deploy through `infra/deploy.sh`. No `.env.prod` secret changes are required.
2. **Primary channel smoke, render and resume.** From the operator's handset, send a weather request with no location. Expected: a plain-text question with the full location ask appears (the `ToolDisplayFn` output, not a truncated tool header). Reply with a city. Expected: Jamis returns that city's weather in the same thread via auto-resume, not a fresh unrelated answer.
3. **Renderer fidelity.** Confirm the question posted is the full question text, not the ~35-character `argsSummary` truncation, and that no `agent-weatherAgent` / `agent-researchAgent` tool-chatter lines appear (the renderer returns nothing for non-`ask_user` events).
4. **Re-post watch.** After the answered check, confirm the renderer did not post the question a second time during auto-resume. If a duplicated question appears, record it and adjust the renderer guard before closing the stage.
5. **Ambiguity smoke.** Send a genuinely ambiguous request. Expected: one focused question, no action. Reply partially, then confirm Jamis re-asks rather than lapsing to a guess.
6. **Non-check smoke.** Send an ordinary message. Expected: a direct reply, no question, no visible tool chatter.
7. **Research-then-check smoke.** Send a verification-required request that needs a decision. Expected: research with citations, then a check; the check question carries no citation block.
8. **Streaming-noise watch.** Confirm `streaming: true` on Sendblue (post-then-edit) does not make the ask flow visibly noisy or broken. If it does, tune the renderer and streaming combination; the check concept is not the thing to change.
9. **Stale-run watch.** After several answered checks, confirm consumed checks do not accumulate in `GET /api/agents/jamis/suspended-runs`. If they do, resolve the cleanup before closing the stage.
10. **Restart-recovery smoke (production).** While a check is pending, restart the app, then confirm the pending check is still discoverable via the authenticated `suspended-runs` endpoint and the operator's next message resumes it.
11. Inspect ClickHouse traces and Postgres messages for the ask, follow-up, re-ask, and direct paths. Confirm `SENDBLUE_*` and other secrets are absent, and no check question leaked internal tool names or routing.
12. Confirm authenticated `agent list` still returns only `jamis`; `tool list` includes `ask_user`; the Sendblue webhook is unchanged; Cloudflare Access is unchanged; and `resume-stream` / `suspended-runs` reject requests without a valid bearer token.
13. Record UTC results and the production SHA in this plan, then rerun the full repository gate: `bun run typecheck`, `bun run lint`, `bun run build`, and `git diff --check`. `bun run test` remains excluded because its unchanged placeholder script exits with `Error: no test specified`, as documented in plan 006.

**Rollback.** On the deployment branch, revert the `ask_user` checks commits, obtain separate approval to push, verify the remote branch SHA, and rerun `infra/deploy.sh`. `toolDisplay` returns to a string mode, `streaming` returns off, and `maxSteps` to `5` as part of the revert. No database or webhook rollback is required.

**Proposed commit.** `docs: record HITL rollout`

## Acceptance

| # | Check |
| :---: | :--- |
| 1 | Jamis remains the only public Mastra agent |
| 2 | A request needing clarification or confirmation makes Jamis suspend a run through the built-in `ask_user` tool and act on the operator's answer |
| 3 | The check question renders as full plain text on iMessage via the `ToolDisplayFn` under `streaming: true`; it is not the truncated tool header, and no delegation tool-chatter appears |
| 4 | An ambiguous answer triggers a re-ask on a fresh run, bounded per run by `maxSteps: 8`, and the final action reflects only the last clear answer |
| 5 | `autoResumeSuspendedTools` is set, and the operator's reply reaches Jamis as the answer in a follow-up run |
| 6 | Only Jamis holds `askUserTool`; subagents do not ask |
| 7 | Balanced policy is worded: Jamis checks before consequential or irreversible actions and when a clarification changes the outcome — policy-only this slice, with no write tool to gate yet |
| 8 | An unambiguous request never triggers a check, and check questions never carry a `Sources:` block |
| 9 | A researched answer following a check still obeys the `[1]`/`Sources:` citation contract from ADR 0011 |
| 10 | A suspended check survives a server restart is recoverable through `suspended-runs` / `resume-stream`, and a consumed check does not linger in `suspended-runs` |
| 11 | `approve-tool-call` / `decline-tool-call` remain unused; `requireApproval` is deferred this slice |
| 12 | All smoke tests pass against the real Sendblue line, and authenticated endpoints reject unauthenticated requests |

## Tuning and graduation

Keep tuning values in code and review changes through Git.

1. Start with a balanced ask policy, `autoResumeSuspendedTools: true`, `toolCallConcurrency: { limit: 8, strategy: 'called' }`, and `maxSteps: 8`.
2. If Jamis asks too often on trivial messages, tighten the instructions to check only when a clarification would change the outcome.
3. If Jamis acts on consequential steps without checking, strengthen the check instruction; once a write tool exists, revisit whether it also carries `requireApproval` or a confirmation check.
4. Add a separate ADR and plan when the first action tool (todos, tasking, or planning) lands, so its confirmation path is recorded against ADR 0012.
5. Revisit this design if a future stable `@mastra/core` renders suspended `ask_user` questions on channels natively; the `ToolDisplayFn` and `streaming: true` could then be dropped.
6. Reconsider a buttoned approval surface only if a future action becomes frequent and consequential enough that text confirmation proves insufficient on iMessage.

## Out of scope

- Todos, tasking, planning, or any action/write tool; their confirmation paths are separate plans
- `requireApproval`, `suspend()` in custom tools, `submitPlanTool`, or task tools in this slice
- A buttoned or web-based approval UI, Studio-based approval, or any off-channel surface
- Custom tool-call counters, a code-enforced "must ask" detector, or a rules engine
- Giving subagents their own `askUserTool`, or any change to the research/weather delegation boundaries
- Model changes, model fallbacks, or a casual-versus-verification router
- Any change to the Sendblue webhook, Cloudflare Access, or the operator allowlist

## Execution rhythm

Each repository stage is independently committable. After implementing a stage, run its verification, show the diff summary and proposed commit message, and wait for explicit approval before committing. Approval to commit is not approval to push; pushing requires separate confirmation.
