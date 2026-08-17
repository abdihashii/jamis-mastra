# 006: Jamis supervisor agent

Status: **Planned.**

Text the Sendblue line, reach Jamis, and receive one answer that Jamis either produces directly or assembles after delegating bounded work to an internal subagent.

The first slice proves the whole supervisor path with the capability already in the repo: `weather-agent` remains responsible for live weather and `weatherTool`, while Jamis becomes the only public Mastra agent and the only channel-facing agent. No new specialist, tool, dependency, secret, storage schema, or memory feature enters this plan.

Off `main` at `9f7cade`.

## Decisions

- **Use Mastra's adaptive supervisor pattern.** Jamis stays in control, chooses whether to answer directly or delegate, and synthesizes the final reply. The deprecated `.network()` API, a deterministic routing workflow, and council-style broadcast are not used.
- **Keep tools scoped to their owner.** `weatherTool` remains available only to `weather-agent`. Jamis may receive future cross-cutting tools only when they do not duplicate a subagent's capability.
- **Make `weather-agent` internal.** Only Jamis is registered on the Mastra instance. Direct weather-agent API and Studio access are removed.
- **Put memory on Jamis.** Jamis owns the durable channel conversation and the existing observational-memory configuration. `weather-agent` omits explicit memory and inherits Mastra's isolated subagent memory during delegation.
- **Start a clean Jamis channel thread.** Existing weather-agent messages remain in Postgres, but they are not copied into Jamis memory.
- **Reuse the current model.** Jamis and `weather-agent` use `fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731`, avoiding a provider or model change in the supervisor slice.
- **Verify with the real model and traces.** Prompt-mocking tests would assert a scripted route rather than the behavior being shipped. Local API calls, synthetic Sendblue replay, and ClickHouse traces are the acceptance surface.
- **Accept a simple in-place cutover.** This is a new, single-operator system. No temporary dual webhook path or compatibility layer is warranted.

### Mastra facts this plan depends on

Verified against installed `@mastra/core@1.59.0`, its embedded documentation, the Mastra MCP, and current Mastra documentation fetched with Firecrawl:

| Fact | Consequence |
| :--- | :--- |
| Supervisor agents define subagents through the parent agent's `agents` property | Jamis receives `agents: { weatherAgent }` |
| The parent uses its instructions and each subagent's `description` to decide when to delegate | `weather-agent` needs a precise description of its boundary and result |
| `.stream()` and `.generate()` are the recommended supervisor entry points; `.network()` is deprecated | The channel's normal agent execution path is sufficient; no network API or workflow is added |
| Subagents are exposed to the parent as `agent-<key>` tools | A weather trace should contain `agent-weatherAgent` before `weather-tool` |
| A subagent without explicit memory inherits the supervisor's `Memory` instance and options | The existing memory configuration moves from `weather-agent` to Jamis |
| Delegation forwards the parent conversation but stores only the delegation prompt and response in a fresh subagent thread | Jamis keeps the canonical conversation while weather work stays isolated |
| The default maximum is five sequential LLM steps | Jamis pins `defaultOptions: { maxSteps: 5 }` as an explicit cost and loop bound |
| A supervisor can delegate several independent calls, while fixed parallel fan-out belongs in a workflow or council pattern | This slice leaves delegation adaptive and adds no parallel orchestration code |

## Public interface changes

- `GET /api/agents` and Studio expose `jamis`, not `weather-agent`.
- The Sendblue webhook moves from `/api/agents/weather-agent/channels/sendblue/webhook` to `/api/agents/jamis/channels/sendblue/webhook`.
- The Cloudflare Access bypass remains `/api/agents/*/channels/*/webhook`; no Cloudflare change is required.
- The five existing Sendblue and allowlist environment variables remain unchanged.
- Postgres and ClickHouse schemas remain unchanged. Existing weather-agent records are retained.

## Stage 1: record the supervisor boundary

**Goal.** Capture the domain language and architectural choice before implementation depends on them.

**Critical files.** `CONTEXT.md`, new `docs/adrs/0009-jamis-as-mastra-supervisor.md`, this plan.

Update the Jamis glossary entry to remove "to be built" and describe Jamis as the channel-facing personal agent. Add **Subagent** as the canonical name for an internal agent that accepts bounded delegated work from Jamis. Avoid "specialist" and "worker agent."

ADR 0009 records why Jamis uses Mastra's adaptive supervisor pattern instead of a routing workflow or council broadcast. It also records scoped tool ownership, supervisor-owned memory, internal-only subagents, and the accepted dependency on model-driven delegation.

Historical plan 005 remains unchanged. Its exclusion of Jamis describes the boundary of that completed channel slice, not the current architecture.

**Verify.** Documentation links resolve and `git diff --check` passes.

**Proposed commit.** `docs: define the jamis supervisor boundary`

## Stage 2: build the vertical supervisor slice

**Goal.** Jamis handles ordinary conversation directly and delegates live-weather work locally.

**Critical files.** New `src/mastra/agents/jamis.ts`, `src/mastra/agents/weather-agent.ts`, `src/mastra/index.ts`.

Create `jamis` with:

- `id: 'jamis'` and name `Jamis`
- the existing Fireworks DeepSeek model
- `agents: { weatherAgent }`
- the observational-memory configuration currently on `weather-agent`
- `defaultOptions: { maxSteps: 5 }`
- the existing Sendblue adapter, `toolDisplay: 'hidden'`, `gateway: false`, operator allowlist, and disabled mention and subscribed-message handlers

Jamis's instructions encode the glossary personality and the coordination contract:

- Answer ordinary conversation directly when no live or delegated capability is needed.
- Delegate current-weather and current-condition requests to `weatherAgent`.
- Treat subagent results as evidence, not as a ready-made channel reply.
- Combine delegated results with the operator's full request and return one concise response.
- State missing capability or failed work plainly instead of inventing an answer.
- Do not narrate routing, tool calls, or internal agent names unless the operator asks.

Add a `description` to `weatherAgent` that says when Jamis should call it, what live source it uses, and that it returns concise current conditions for a requested location. Remove its `channels` and explicit `memory` configuration, but leave its model, weather instructions, and `weatherTool` unchanged.

Register only `{ jamis }` in `src/mastra/index.ts`. Do not add delegation hooks, message filters, completion scorers, background tasks, direct Jamis tools, or a shared model constant.

**Verify.**

1. `bun run typecheck`, `bun run lint`, and `bun run build` pass.
2. With the local server running, authenticated `mastra api agent list` returns only `jamis`.
3. A general greeting gets a direct Jamis reply with no `agent-weatherAgent` trace span.
4. "What is the current weather in Chicago?" produces one response and a trace containing Jamis, `agent-weatherAgent`, and `weather-tool` in that order.
5. A mixed request such as "What is the current weather in Chicago, and what should I wear?" delegates the live lookup and receives one Jamis synthesis.
6. An unsupported request such as a calendar lookup gets a candid limitation and does not call `weather-agent`.
7. Two authenticated API calls with the same explicit memory resource and thread demonstrate same-thread recall by Jamis.
8. A valid synthetic Sendblue replay to the Jamis webhook returns `200`, sends one text, and creates one Jamis channel trace.
9. Missing and incorrect `sb-signing-secret` values return `401` with no agent run.
10. A non-allowlisted sender returns `200` with no reply, thread, message, or model run.
11. The old weather-agent webhook path is unavailable.

The tracked fixture keeps reserved test numbers. A valid local replay substitutes the operator and Sendblue numbers from local environment variables in memory; no real phone number or captured message is written to disk.

The current `test` package script intentionally fails with "no test specified," so it is not a gate for this slice. The real-model routing smokes and traces above are the delegation tests.

**Proposed commit.** `feat: add jamis supervisor agent`

## Stage 3: cut production iMessage over to Jamis

**Goal.** The operator texts Jamis in production and receives direct or delegated answers.

**Critical files.** None in the repo. Sendblue webhook registration and the normal production deploy path.

1. Record the exact pre-deploy production SHA for rollback.
2. List Sendblue receive webhooks and delete the existing weather-agent entry.
3. Deploy the approved supervisor commit through `infra/deploy.sh`.
4. Register exactly one signed `receive` webhook at `https://mastra-agent.jamis.xyz/api/agents/jamis/channels/sendblue/webhook` using the existing secret.
5. Confirm the webhook list contains that one entry and no weather-agent entry.

No Cloudflare application, environment variable, database, or Docker volume changes in this stage.

**Verify.**

| Check | Expected |
| :--- | :--- |
| General text from the operator | One Jamis response; no weather subagent span |
| Weather text from the operator | One response; trace contains Jamis, `agent-weatherAgent`, and `weather-tool` |
| Follow-up text | Jamis recalls the preceding channel exchange |
| Unsigned Jamis webhook POST | `401`; no reply or run |
| Public `GET /api/agents` | `302` to Cloudflare Access login |
| Authenticated tailnet agent list | Only `jamis` |
| Sendblue webhook list | Exactly one signed Jamis `receive` URL |
| Old weather webhook | Unregistered and unavailable |
| Postgres | Old weather records remain; new messages belong to a Jamis channel thread |
| ClickHouse | Direct and delegated Jamis trace roots complete successfully |
| Docker volumes | `jamis_pgdata` and `jamis_chdata` remain present |

**Rollback.** Delete the Jamis receive webhook and redeploy the recorded pre-deploy SHA. Re-register the old weather webhook only if the old version is restored and inbound weather service is still wanted.

**Commit.** None. Deploy only.

## Stage 4: record rollout and close the gate

**Goal.** Preserve production evidence and leave the repository fully verified.

**Critical files.** This plan and, only if implementation revealed a durable architectural fact, ADR 0009.

Mark each stage and acceptance check with its result and UTC completion date. Record facts learned during implementation without rewriting completed historical plans.

Re-run the full available repository gate:

- `bun run typecheck`
- `bun run lint`
- `bun run build`
- `git diff --check`

Report command results, the final diff summary, and the complete commit list.

**Proposed commit.** `docs: record jamis supervisor rollout`

## Acceptance

| # | Check |
| :---: | :--- |
| 1 | Jamis is the only public Mastra agent |
| 2 | General conversation is answered directly |
| 3 | Current weather is delegated through `weather-agent` to `weatherTool` |
| 4 | Mixed requests receive one synthesized Jamis response |
| 5 | Unsupported capabilities are admitted without false claims or irrelevant delegation |
| 6 | Jamis recalls a same-thread follow-up |
| 7 | iMessage reaches the Jamis webhook and produces one reply |
| 8 | Invalid signatures and non-allowlisted senders still fail closed |
| 9 | Sendblue has exactly one Jamis receive webhook |
| 10 | Cloudflare protection outside channel webhooks is unchanged |
| 11 | Existing database records and volumes remain intact |

## Out of scope

- New subagents or tools beyond the existing weather capability
- Working memory, semantic recall, cross-thread migration, or a broader memory architecture
- Deterministic routing workflows, council fan-out, handoffs, or the deprecated `.network()` API
- Delegation hooks, message filtering, task-completion scorers, background execution, or agent approval
- Model selection, provider changes, model configuration variables, or fallbacks
- Group messages, media, reactions, additional channels, and multiple operators
- Rate limiting or changes to the accepted channel security risks in plan 005

## Execution rhythm

Each repository stage is independently committable. After implementing a stage, run its verification, show the diff summary and proposed commit message, and wait for explicit approval before committing. Approval to commit is not approval to push; pushing requires separate confirmation.
