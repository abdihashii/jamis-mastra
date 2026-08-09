# 002 — Build Jamis (supervisor agent + iMessage channel)

Status: **planned.** No stages started. Decisions below are settled; the open questions at the bottom are not.

## Context

Plan 001 finished the infrastructure and none of the product. `jamis-prod` is live, hardened, and deploys in one command; `mastra-agent.jamis.xyz` sits behind Cloudflare Access with a bearer token behind that. But the only agent in the repo is `weather-agent`, the Mastra starter template. Jamis, the agent `CONTEXT.md` defines with `id: 'jamis'`, does not exist.

This plan builds him. Nothing in the repo said what Jamis was for, so it was settled while drafting this plan.

**Jamis: Just A Mostly Intelligent System.** He is a JARVIS, and the relationship to model is JARVIS and Tony Stark. Concretely:

> A personal agent I text like a person, that actually remembers me across days, projects, and contexts. A single place to think out loud that accumulates context on my life and work instead of restarting every session. Over time, a chief of staff who knows my context and takes work off my plate.

The JARVIS framing is not decoration, it decides real things. JARVIS never asks Tony to re-explain himself, which is why memory is stage 2 and not a later nicety. JARVIS is dry and understated rather than eager, and he tells Tony the thing Tony does not want to hear. And "Mostly Intelligent" sets the register: self-aware about its own limits, never overselling what it knows.

Day one is deliberately small: **talk, with memory.** The architecture, however, is the **supervisor pattern** from the start, so specialists are added rather than retrofitted.

## Architecture: supervisor

Mastra's supervisor pattern (`docs/capabilities/subagents`): one lead agent stays in control for the whole task, decides when to delegate, which specialist to call, what context to pass, and how to combine results. Jamis is the supervisor. Specialists hang off his `agents: {}` map.

This is the right pattern here because the work is open-ended. You text one sentence and Jamis works out what it needs, which is exactly the case where a fixed workflow graph is the wrong shape.

**Avoid `.network()` / agent networks.** Deprecated in Mastra and slated for removal; supervisor agents replace them.

Three consequences that shape the stages:

- **Memory belongs to the supervisor.** Subagents get isolated memory and a fresh thread per invocation. Continuity is Jamis's property; specialists stay stateless. This matches the product exactly.
- **Subagents need a `description`.** It is what the supervisor reads to decide when to delegate. A vague description is a delegation bug.
- **Approvals bubble up.** A tool with `requireApproval: true` inside a specialist surfaces at Jamis's level and can be answered there. That is the confirm-before-acting mechanism, for free, when it is eventually needed. Not in this plan.

Following Mastra's own advice ("start with one agent when possible"), Jamis ships with an empty `agents: {}` map in stage 2 and gains his first real specialist in stage 4. Be honest about what that means: **until stage 4 the supervisor is structural, not functional.** The seam is cut so stage 4 is additive.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Pattern | Supervisor agent | Open-ended work; Mastra's recommended multi-agent approach |
| Day-one scope | Talk + memory, zero specialists | Smallest thing that is still the product |
| Memory | Mastra-native, in Postgres | Working memory (resource-scoped) + observational memory. No hand-rolled memory layer. |
| First channel | iMessage via Sendblue | The channel actually wanted; number and account already owned |
| Webhook vs Access | Access **Bypass** rule scoped to one path | One dashboard rule, reversible. Route verifies the signature itself. |
| Model | `fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731` | Already wired and working in `weather-agent` |
| Backups | Still deferred | Raised once and declined. Accepted: a dead box means Jamis's memory restarts from zero. |

Out of scope: approvals/confirm-before-acting, skills, more than one specialist, the `agent.jamis.xyz` hostname cutover (plan 001 open question 4), backups, any second channel.

## Why these stages, in this order

Stage 1 retires the highest-risk concern: a public unauthenticated path punched through Cloudflare Access, driven by `chat-adapter-sendblue@0.2.0`, a package published in April 2026. It does that with an echo and no agent involved, so a failure is unambiguously the channel's fault. Stage 2 builds Jamis behind Studio, where channel problems cannot masquerade as agent problems. Stage 3 connects them, and there is a usable product. Stage 4 proves the supervisor pattern actually delegates.

---

## Stage 1 — iMessage reaches the box (echo, no agent)

**Goal:** text the Sendblue number from the iPhone, get an echo back.

Dashboard first, in this order:

1. Zero Trust → Access → Applications → the `mastra-agent.jamis.xyz` application → add a second policy, **action Bypass**, scoped to path `/webhooks/sendblue` only. The existing `allow-me` policy stays and keeps covering everything else.
2. Sendblue dashboard → set the inbound webhook URL to `https://mastra-agent.jamis.xyz/webhooks/sendblue`, and set a signing secret.

Note the path is `/webhooks/sendblue`, **not** under `/api/`. Plan 001 B4 put SimpleAuth on every `/api/*` route; keeping the webhook outside that namespace means the Access bypass and the auth exemption do not have to agree with each other.

Repo changes:

- `apps/agent/package.json`: add `chat`, `chat-adapter-sendblue`, `@chat-adapter/state-memory`. Pin `chat-adapter-sendblue` to an exact version, no caret. It is 0.2.0 and young.
- New `apps/agent/src/channels/sendblue.ts`: builds the `Chat` instance with `createSendblueAdapter()` and `createMemoryState()`, registers the `onDirectMessage` handler, exports the webhook handler.
- `apps/agent/src/mastra/index.ts`: register the route.

```ts
registerApiRoute('/webhooks/sendblue', {
  method: 'POST',
  requiresAuth: false, // Access bypasses this path; the handler authenticates the caller itself
  handler: async c => chat.webhooks.sendblue(c.req.raw),
})
```

- Both env templates (`.env.example`, `.env.prod.example`) gain `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`, `SENDBLUE_WEBHOOK_SECRET`, and `JAMIS_ALLOWED_NUMBER`. Real values go only into `.env.prod` on the box.

**This path is open to the internet.** Three things guard it, all in this stage:

- `SENDBLUE_WEBHOOK_SECRET` set, so the adapter verifies the `sb-signing-secret` header.
- `JAMIS_ALLOWED_NUMBER` whitelist on the inbound `from_number`. Jamis is single-user; anything else is dropped without a reply.
- The handler returns 200 fast and does no expensive work in stage 1.

**Verify:** text the Sendblue number from the phone, get the echo. Then POST to the webhook with no signature and confirm it is rejected, not echoed. Then confirm `curl https://mastra-agent.jamis.xyz/api/agents` still 302s to the Access login, proving the bypass did not widen.

**Commit:** `feat(agent): sendblue imessage webhook with echo`

## Stage 2 — Jamis the supervisor, in Studio

**Goal:** an agent that knows you across two separate threads, demoed in Studio over the tailnet.

- New `apps/agent/src/mastra/agents/jamis.ts`, `id: 'jamis'`, registered in the `agents: {}` map on the `Mastra` instance alongside `weatherAgent`.
- Instructions have three sections, so later stages edit one section rather than restructuring the agent:
  1. **Who he is.** The purpose lines from Context above, verbatim.
  2. **Voice.** JARVIS to Tony Stark: concise, dry, understated. Never eager, never sycophantic, no emoji, no "Great question!" Assume competence and skip the preamble. Say the inconvenient thing plainly rather than softening it. When he does not know, say so rather than fill the space, which is what "Mostly Intelligent" is doing in the name.
  3. **Coordination.** What specialists exist, when to delegate, and to answer directly when none fits. In this stage the list is empty and the instruction is to always answer directly. Stage 4 fills it in.
- `agents: {}` present and empty, so stage 4 is one entry, not a rewrite.
- Memory. Do **not** copy `weather-agent.ts` here; its config is thread-scoped and would make Jamis forget between conversations.

```ts
memory: new Memory({
  options: {
    // Immediate and cross-thread. This is the day-to-day continuity mechanism.
    workingMemory: { enabled: true, scope: 'resource' },
    observationalMemory: {
      model: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
      scope: 'resource', // REQUIRED. Defaults to 'thread'.
      activateAfterIdle: 'auto',
    },
  },
})
```

Three things verified in `@mastra/core@1.57.0` types (`dist/memory/types.d.ts`) that the config above depends on:

- **`observationalMemory.scope` defaults to `'thread'`**, unlike working memory's, which already defaults to `'resource'`. Leaving it unset silently confines every observation to one conversation. This is the single easiest way to build the exact product failure this plan exists to prevent, and nothing errors when you get it wrong. `weather-agent.ts` omits it today.
- **Observations do not form quickly.** `observation.messageTokens` defaults to 30000 unobserved tokens before the Observer runs, which is a great deal of texting. So working memory carries continuity day to day, and observational memory is long-horizon compression that arrives much later. `activateAfterIdle: 'auto'` lets observations form during natural pauses instead of waiting on the token threshold, which suits a texting cadence.
- **Do not set `observation.manageWorkingMemory: true`.** It reads like an upgrade, but it flips `workingMemory.agentManaged` to false and hands working memory to the Observer, so updates land only when observation activates. Combined with the point above, telling Jamis a fact could take days to stick. Leave it at its `false` default so the agent writes working memory immediately via its tool call.

**Verify:** in Studio, one `resource`, two different `thread` ids. Tell Jamis something in thread A, open thread B, ask about it. He knows. Trace visible in observability. This test is the whole point of the stage: it is the only thing that catches a thread-scoped misconfiguration, because a single-thread test passes either way.

Also check the voice, since it is now a requirement and not a vibe: ask him something he cannot know and confirm he says so instead of guessing, and confirm no reply opens with flattery or a restatement of the question. If the model will not hold the register, that is an instructions problem to fix here, before the channel makes every reply land on the phone.

**Commit:** `feat(agent): jamis supervisor agent with resource-scoped memory`

## Stage 3 — Route iMessage to Jamis

**Goal:** text Jamis from the phone, get a real answer, and have him still know it tomorrow.

- `apps/agent/src/channels/sendblue.ts`: replace the echo with `mastra.getAgent('jamis')` and a `generate()` call, then `thread.post()` the result.
- Identity mapping, which is what makes memory work:
  - `resource` = a constant for the operator. Same value forever, across every thread and channel. This is the key working memory is scoped to.
  - `thread` = derived from the Sendblue conversation. One long-lived thread is correct here; observational memory compresses it as it grows.

**The timing gotcha to solve in this stage.** Sendblue expects a fast webhook response, and Jamis will take much longer than that to think. Awaiting the agent inside the handler risks a Sendblue timeout and retry, which arrives as a duplicate message and a duplicate reply. Ack 200 immediately, do the agent work after the response, and deduplicate on the inbound message id. Chat SDK's state layer provides the dedupe and locking; `@chat-adapter/state-memory` is fine for a single container and loses the dedupe cache on restart. Swap to `@chat-adapter/state-redis` only if that actually bites.

**Verify:** text him a fact. Separately, text him something unrelated. Later, ask about the first thing. Trace shows the memory read. Restart the container and confirm he still knows.

**Commit:** `feat(agent): route imessage conversations to jamis`

## Stage 4 — First specialist (proves the supervisor pattern)

**Goal:** Jamis delegates to a subagent and synthesizes the result, visible in a trace.

The pattern needs something to delegate to. **Recommended first specialist: research**, a subagent with one web search tool. It is read-only, needs one API key, has no OAuth, and cannot damage anything. It is also the capability that most obviously exceeds what Jamis can do alone, which is what makes the delegation decision legible in a trace. This is the one substantive assumption in the plan and it is a one-line swap if a different first specialist is more useful.

- New `apps/agent/src/mastra/agents/research-agent.ts` with a `description` written for the supervisor to read, plus its search tool under `src/mastra/tools/`.
- `jamis.ts`: add it to `agents: {}` and fill in the coordination section of the instructions.
- Add `onDelegationComplete` logging so delegations are greppable, and set a `maxSteps` ceiling so a bad delegation loop cannot run away.

**Verify:** in Studio first, then from the phone. Ask something requiring current information. The trace shows Jamis delegating to `research-agent` and synthesizing, not answering from the model's own knowledge. Then ask a plain conversational question and confirm he does **not** delegate. Both directions matter; a supervisor that always delegates is as broken as one that never does.

**Commit:** `feat(agent): research specialist under the jamis supervisor`

## Stage 5 — Docs

- `CONTEXT.md`: fill in the Jamis entry with what he is now rather than what he will be, including the expansion (Just A Mostly Intelligent System) and the JARVIS framing, since it is what the voice section of the instructions is derived from. Add language entries for **Supervisor**, **Specialist**, and **Channel**.
- This file: record results per stage, as 001 does.

**Commit:** `docs: record plan 002 results and jamis language`

---

## End-to-end verification

1. `pnpm typecheck` and `pnpm lint` clean across the workspace.
2. `JAMIS_HOST=100.105.239.41 ./infra/deploy.sh`, four containers healthy.
3. From the phone, laptop closed: text Jamis, get an answer that reflects something told to him in an earlier conversation.
4. Ask something needing current information; the trace shows a delegation to `research-agent`.
5. `curl https://mastra-agent.jamis.xyz/api/agents` still 302s to Access.
6. Unsigned POST to `/webhooks/sendblue` is rejected.
7. Studio over the tailnet lists `jamis` and `research-agent` and shows their traces.

## Verified against the installed packages (2026-08-09)

Every Mastra package in `apps/agent` was at the latest published version when this plan was written, so nothing here needs an upgrade first:

`@mastra/core` 1.57.0, `@mastra/memory` 1.26.0, `@mastra/pg` 1.19.0, `@mastra/clickhouse` 1.14.0, `@mastra/observability` 1.16.5, `mastra` 1.23.0.

Each API this plan depends on was checked against the installed `.d.ts` files rather than the docs:

| Claim | Where verified |
| --- | --- |
| `registerApiRoute(path, opts)` exists, `requiresAuth?: boolean` is real | `core/dist/server/index.d.ts:43,53` |
| Subagents: `agents?: DynamicArgument<Record<string, SubAgent>>` on `Agent` | `core/dist/agent/types.d.ts:651` |
| Delegation hooks `onDelegationStart` / `onDelegationComplete` / `messageFilter` | `core/dist/agent/agent.types.d.ts` |
| `workingMemory.scope` defaults to `'resource'` | `core/dist/memory/types.d.ts:104-113` |
| `observationalMemory.scope` defaults to `'thread'` | `core/dist/memory/types.d.ts:698-705` |
| `observation.messageTokens` defaults to 30000 | `core/dist/memory/types.d.ts:365-370` |
| `manageWorkingMemory` disables `agentManaged` | `core/dist/memory/types.d.ts:355-363` |

Third-party, checked on npm: `chat@4.37.0`, `chat-adapter-sendblue@0.2.0`, `@chat-adapter/state-memory` / `state-redis` at 4.37.0.

## Notes for the executor

- Per-stage sign-off before every commit. Pushing needs its own separate ok.
- `mcp__mastra__searchMastraDocs` needs `projectPath` = `/Users/abdirahmanhaji/dev/jamis-mastra/apps/agent`. It only covers `@mastra/core` and `@mastra/memory`; use the remote `mastraDocs` tool for everything else.
- Mastra docs lag the code. Two of the three memory findings above are absent from the prose docs and only visible in the types. Verify against the installed packages before trusting a doc example.
- Do not use `.network()` or agent networks; deprecated in favor of supervisor agents and slated for removal.

## Open questions

1. **Chat SDK may not earn its place.** For "talk with memory" it buys typing indicators, tapbacks, and iMessage/SMS fallback. Inbound is plain JSON and outbound is one REST call, so a direct integration is a plausible simplification if the adapter fights us at 0.2.0. Revisit at the end of stage 1, not before.
2. **Backups.** Deferred by decision. From stage 3 onward, losing the box loses Jamis's memory permanently. That is the only unrecoverable state in the system.
3. **Which specialist is actually first.** Stage 4 assumes research.
4. **Access service token** (plan 001 open question 2) is still unbuilt. Stage 1's bypass covers the webhook only; programmatic calls to `/api/*` from outside the tailnet still have no route in.
