# 029: Typed Jamis delegation and confirmed-action continuation

Status: reviewed staged plan, prepared 2026-10-08 UTC. Design review is complete; implementation, runtime proof, and deployment have not started. The three GPT-6-Luna max passes supplied read-only code exploration, installed-Mastra research, and bounded web research. Nine GPT-6-Astra review passes found no verified design blocker; Mastra API claims were reconciled with the original researcher. Research caches remain ignored.

Tracking: [JAM-77: Make Jamis delegation and action continuation deterministic](https://linear.app/abdirahman-haji/issue/JAM-77/make-jamis-delegation-and-action-continuation-deterministic). Its title/body now follow the reviewed plan and JAM-59's general structure, with all 15 implementation acceptance criteria unchecked. The ticket keeps Context, Goal, Acceptance criteria, Not in scope, and Sources; framework detail and stage scope live in this plan. Working branch: `codex/jam-77-agent-architecture`. No subissues were created.

## Accepted scope and source of truth

The [architecture record](../jamis-agent-architecture.md) owns the design and its walkthroughs. The [Jamis glossary](../CONTEXT.md) owns terminology. This plan sequences delivery rather than duplicating those contracts.

- Keep Jamis as Supervisor and the only Operator-facing conversational voice. Ownership belongs to the scoped assignment, including when a domain owner uses a capability specialist.
- Introduce typed specialist handback through native Mastra tools and structured agent generation. Keep domain payloads and completion checks with their specialists; authorization, effects, decline, and execution failure remain runtime facts.
- Permit configured domain-to-Research contributions through one public-only entry boundary. Keep Research's evidence, refusal, pricing, sequential execution, and existing task-budget policies. Domain-to-domain and further capability-agent delegation remain unavailable.
- Handle one active conversational task at a time. Use fresh bounded invocations for clarification and reasoning, and one concrete native workflow for the email-to-Linear-to-text-draft procedure.
- Preserve [ADR 0022](../adrs/0022-confirm-linear-issue-writes-in-text.md). After verified confirmed creation, immediately finish the already requested text reply and return the issue link and draft together. Gmail remains read-only; every future email send would need separate exact confirmation.
- Enforce the accepted [broadcast confirmation amendment](../adrs/0017-fantasy-group-is-passive-channel-context.md#architecture-amendment-operator-requested-broadcast-confirmation): exact draft review and next-message confirmation in the active Operator DM. Scheduled weekly recap delivery retains its separate policy.
- Follow the existing `verb_object` tool-naming rule for new invocation tools and migrated registrations. Account for callers, prompts, fixtures, observability, and historical incident lookup whenever a touched name changes. A bulk rename of unrelated tools is outside this delivery.

Memory redesign, new dependencies/services, general task/dependency scheduling, parked-task queues, background continuation, expanded Linear writes, Gmail draft APIs, email sending, and new specialists are excluded. Existing project, Monitoring, Incident, time-zone, login, and scheduled Fantasy behavior must keep working.

## Code context and verified defaults

| Current boundary | Consequence for delivery |
| --- | --- |
| `src/mastra/index.ts` registers Jamis and the scheduled `fantasy` agent; `agents/jamis.ts` attaches four internal specialists through `agents`. | Preserve the existing public/channel surface while changing internal composition. |
| Specialist outputs are prose; native `Agent.agents` drops the child's structured object. | Carry `response.object` explicitly through a native tool with matching output validation. |
| Native delegation currently supplies registration, message/context handling, hooks, tracing, and cancellation. | Direct invocation must replace the relevant behavior deliberately; deleting the raw delegation entry alone is insufficient. |
| `sendblue.ts` consumes confirmed Linear creation before normal routing, posts the outcome, then returns. | Add an explicit owner/procedure continuation; conversation memory cannot bridge it by itself. |
| `linear-proposals.ts` owns receipts, exact operation, claim, outcome, and notification, but has no continuation reference. Its selector excludes notified terminal rows. | Extend this existing owner with durable correlation and a continuation-aware lookup; do not introduce another approval/effect ledger. |
| Gmail returns bounded content without a reusable message ID. Calendar silently skips selected calendars returning 403/404. | Persist the selected bounded source for the procedure, and surface missing Calendar coverage in typed results rather than claiming completeness. |
| `fantasy/broadcast.ts` claims a saved draft before sending, but has no executable confirmation/session check. | Add the accepted authority gate inside the send owner and channel intake. Duplicate protection alone is insufficient. |
| Protected trace/log/metric handling and incident mappings depend on agent/tool identities. | Preserve safe parent/root attribution and historical lookup while new invocation paths are introduced. |

Framework defaults verified against `@mastra/core@1.71.0` and `@mastra/pg@1.27.1`:

- Build the common Mastra runtime first. Construct internal specialists with public `AgentConfig.mastra`, then use public `addAgent()`/`addWorkflow()` for the existing public roots and concrete procedures. Do not call internal registration methods or create a second Mastra runtime. The constructor seam is public-typed and source-supported, with integrated acceptance still required.
- Use strict structured output. Reject a missing object and native `ValidationError` values, using the exported validation helper where appropriate. Callers cannot supply generation options, instructions, toolsets, models, contexts, or memory bindings.
- Keep workflow validation enabled and snapshots persisted for `running` as well as suspended/terminal states. Installed Postgres supports the native atomic suspension claim. Set action-procedure retries to zero and `autoRestartActiveRuns: false`; retain existing service-local safe preflight/credential-refresh behavior.
- Resume can merge stored request context. Persist only intended serializable data, rebuild current authority, and check operation/session eligibility again. Cancellation can swallow storage-update failures. Authenticated start/resume/tool routes require executable checks as well as server authentication.

These are source findings, not runtime proof. The architecture record links exact framework evidence and records the limits of schema validation, model judgment, and delivery claims.

## Delivery slices and stage gates

This work introduces a control contract, private-context projection, durable continuation logic, and a new integration-test surface. Retire their shared native-framework risk in one narrow, unexposed slice first. Then migrate callers, wire the real channel procedure, and close broadcast authority separately. Prompt simplification follows working boundaries.

Each numbered stage is independently committable and preserves functioning routes before the next stage. Implement one stage, run its focused acceptance plus the full repository gate, show the diff/evidence/proposed commit, and wait for explicit commit sign-off. Begin the next stage only after that approved commit. Push, deployment, and live external effects require separate authorization.

The standard gate is `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun test`, `rtk bun run build`, and `rtk git diff --check`. Point both `DATABASE_URL` and `JAMIS_TEST_DATABASE_URL` at disposable loopback `jamis_sessions_test` Postgres so channel/session/Linear contracts actually execute. Keep fixture provider/model/channel traffic controlled. Report skips and failures; do not count a skipped persistence contract as acceptance. Run the existing Docker/project smokes at the final gate, and earlier if composition/workspace behavior changes.

Review each implementation diff with `review-code` and `ponytail:ponytail-review`; use `security-audit` for the context/authority/persistence changes in stages 1-4. Resolve verified blockers before stage sign-off. These reviews have not been run for implementation because no implementation exists yet.

### 1. Prove the native typed and durable boundaries without changing live routes

**Goal:** prove typed tool-using specialist handback, a nested public-only Research contribution, and outcome-driven native workflow recovery together before changing Operator routing.

**Critical files:** proposed specialist handback/invocation modules beside `src/mastra/agents/` and `tools/`; a concrete workflow under `src/mastra/workflows/`; narrow construction changes in the existing specialists; `src/lib/linear-proposals.ts` for optional continuation/decision data; `src/mastra/observability.ts` and focused integration fixtures. A proposed `scripts/jamis-architecture-smoke.ts` and `smoke:architecture` package script provide the demo. Keep the production root toolset/channel routes on their current path in this stage.

**Work:** define only the four model-authored handback cases and specialist-owned payloads. Normalize runtime failure separately. Compose internal agents with the shared runtime constructor seam, fixed call options, explicit context projection, cancellation, and protected trace attribution. Protect added invocation/workflow trace roots from their first event, including authenticated direct entry, rather than assuming every execution has a Jamis parent. Add the native outcome-wait boundary and minimal procedure state using the existing operation owner; the re-entered wait performs no proposal posting or mutation. Add optional durable correlation in a backward-compatible way, including existing tables/rows, without activating continuation in production.

**Verify:** use actual Mastra agents/tools/workflows with controlled model/provider outputs and real disposable Postgres. Cover typed success/help/refusal, malformed/missing output and validation-error values, specialist tool use, configured custom-gateway resolution, internal registry visibility, logger/tracing/memory/abort behavior, and unsupported caller/options. A nested caller's private sentinel must not enter Research messages, context, provider inputs, or added exported metadata; an unsupported public projection must make no provider call. Recover a stored wait by its exact run/operation, compete two resumes, and inject missing outcome/state plus cancellation-persistence failure. Keep the native claim conditions enabled. Existing unbound proposals retain their current behavior. Run the full gate and reviews.

**Demoable acceptance:** the proposed `rtk bun run smoke:architecture` exercises the real modules against controlled effect boundaries, reports typed handback/nested isolation/stored outcome recovery, and observes zero duplicate mutations or outbound messages. Also obtain one bounded real-model, read-only tool-plus-structured-output observation through the configured gateway using synthetic/public inputs and disposable storage. If the public constructor seam or model/gateway combination fails, stop before caller migration and revise the default from that evidence. Do not substitute prose parsing, another runtime/provider/model, or a success-shaped fallback.

**Proposed commit:** `feat: prove native typed specialist and continuation boundaries`.

### 2. Migrate adaptive Weather, Research, and Personal Accounts delegation

**Goal:** make the proven typed boundary the only invocation path for these specialists, preserving their useful behavior and Jamis's final voice.

**Critical files:** `src/mastra/index.ts`; `agents/jamis.ts`, `weather-agent.ts`, `research-agent.ts`, and `personal-accounts-agent.ts`; stage 1 invocation/contracts; `tools/calendar-events.ts`; relevant agent/tool/channel fixtures; `observability.ts` and `tools/triage-incident.ts` only for affected identity mappings.

**Work:** construct specialists with the common runtime and expose only configured invocation tools. Remove their parallel raw `agents` entries; the unmigrated Fantasy route remains until stage 4. Pin caller tool-call concurrency to one so delegated contributions stay sequential. Explicitly configure the permitted domain-to-Research paths and keep Research a leaf. Private-to-public queries use supported question shapes with verified public labels; unsupported projections return a gap through Jamis. Preserve Research instructions, fixed step/concurrency defaults, existing source/refusal/price/budget policy, and prior contributions across fresh owner invocations. Surface skipped Calendar coverage while retaining available events. Preserve the current Linear proposal gate and runtime posting evidence until the continuation integration is ready; typed handback must not invent posting or creation success.

**Verify:** extend the existing research, Weather, Gmail, Calendar, Linear, and native channel tests. Cover weather clarification/fresh continuation and supersession, resolved-place/date checks, calendar-plus-weather partial results, unread/insufficient research evidence and terms-only access metadata, nested needs returning through the owner, ambiguous/truncated account results, inaccessible Calendar coverage, and denied private queries. Verify that migrated specialists have no independent agent route or raw delegation bypass; authenticated tool entry still cannot synthesize authority. Preserve time-zone/login/session commands, native project tools, numeric Monitoring attribution, and historical Incident lookup. Run the full gate and reviews.

**Demoable acceptance:** the controlled native dispatch smoke returns a location check, completes Weather on the next unambiguous answer, and returns an honest partial calendar/weather result on a failed forecast. It also demonstrates a permitted nested Research contribution with no private sentinel at the provider boundary. Specialist results stay internal; the final answer uses Jamis's voice and required domain evidence. The selected simple forecast-plus-alerts report remains Jamis-owned.

**Proposed commit:** `feat: use typed specialist handback in Jamis delegation`.

### 3. Connect exact Linear outcomes to the requested reply draft

**Goal:** complete the selected email-to-issue-to-text-draft procedure across confirmation without repeating creation or reviving superseded work.

**Critical files:** `src/mastra/channels/sendblue.ts`, `src/lib/linear-proposals.ts`, `src/lib/linear.ts`, `src/mastra/tools/linear.ts`, the concrete workflow and Accounts invocation boundary, `src/mastra/index.ts`, and native Linear/session/observability tests.

**Work:** resolve one usable email and retain its bounded validated source plus original scope; do not invent a reusable Gmail ID or reread the latest email on recovery. Restrict preparation-phase tools so a model cannot publish the proposal out of order. Persist the exact prepared operation and suspended wait before publishing through the existing validated DM gate. Store the workflow/run/wait and assignment correlation with the proposal; record the actual decision identity/disposition with claim/cancellation. Keep the existing exact confirmation, receipt/provider-history adjacency, team/scope, session, and single-use rules.

Persist the operation outcome before continuation. Resume with an operation reference, reread authoritative facts, and unlock the text draft only on verified prerequisites and current eligibility. Use fresh bounded owner reasoning, persist the draft, and return the verified issue link and requested text together. Keep confirmed creation visible if drafting/composition/posting fails. The saved Linear notification flag must not hide an unfinished run; final task reply acceptance is separate. Replace proposal-status prose/`otherAnswers` plumbing only where the typed runtime path fully takes over its existing guarantees.

Add the one bounded exact-ID inspection for uncertain creates, retaining the original uncertain attempt and verified inspection in the existing operation record. Absence or mismatched/incomplete evidence cannot prove no effect or authorize another mutation. Recovery must not post again, execute creation again, restart the graph, or run automatically at boot. A fresh unrelated request or `/new` invalidates old continuation before routing; an explicit later return starts fresh bounded preparation with revalidated existing effect facts.

**Verify:** extend `sendblue-linear.test.ts`, `sendblue-sessions.test.ts`, Linear client tests, and stage 1 workflow fixtures. Inject failures before/after snapshot persistence, proposal post/commit, decision claim, provider commit with response loss, outcome persistence, native resume claim, draft persistence, and final reply acceptance. Cover competing resumes, duplicate/repeated confirms, incompatible/stuck/missing runs, old rows without correlation, changed requests, unrelated messages, `/new` replay, active-session change, and a notification already marked accepted. Direct authenticated start/resume/tool calls must not bypass the exact application gate. Assert one mutation attempt at most after a claim and preserve independently verified results. Run the full gate and reviews.

**Demoable acceptance:** a native channel fixture asks for an issue and linked reply, receives the exact proposal, confirms, and obtains the created issue plus text draft. Its simulated restart/replayed confirmation obtains the existing outcome/artifact with no second create. Lost creation response and invalidated-session branches stop dependent drafting honestly. No Gmail draft or email send occurs.

**Proposed commit:** `feat: continue confirmed Linear creation into requested reply text`.

### 4. Enforce exact confirmation for requested Fantasy broadcasts

**Goal:** send a one-off broadcast only after the accepted exact-draft, next-message Operator confirmation, enforced inside application execution.

**Critical files:** `src/fantasy/broadcast.ts`, `src/mastra/agents/fantasy-broadcast-agent.ts`, `agents/jamis.ts`, `channels/sendblue.ts`, internal composition/invocation contracts, `src/fantasy/__tests__/broadcast.test.ts`, and native channel/session/telemetry fixtures. Keep scheduled recap generation/delivery and passive group ingestion on their existing paths.

**Work:** make the exact saved draft and configured group the pending operation. Bind review/posting, source DM/message, active session, actual decision, single-use claim, and outcome through the existing broadcast owner. Preparation alone does not authorize sending; a same-turn request to draft and send still needs later exact confirmation. `confirm` uses Linear's trimming/case rule; `decline`, other next input, edits, and `/new` invalidate the pending send. One pending action confirmation spans the existing action owners, so one reply cannot authorize a broadcast plus Linear/time-zone work. Do not build a generic approval ledger.

The send owner must reject missing/forged/direct authority even when a draft ID exists. Route validated confirmation to that owner without relying on a model to classify approval. Preserve exact stored bytes and duplicate protection. Retain uncertain send outcomes after possible execution; re-arm only a proven pre-send failure, never an unexpected exception after a possible send. Complete typed internal handback for the drafter and remove its raw delegation bypass. Jamis handles the Operator conversation while quoted group draft content retains its own voice.

**Verify:** use controlled Sendblue effects and real disposable persistence. Cover reviewed draft/confirm success, no approval, fabricated context, wrong DM/session/group/draft, `yes`/`send it`/punctuated confirm, altered text, unrelated input, duplicate/concurrent confirmation, `/new` replay, competing action proposals, restart around claim/outcome, failed review posting, provider acceptance with lost response, and outcome-notification failure. Existing tests intentionally avoid outbound success; add a controlled accepted-send fixture and assert exact bytes and one attempt. Preserve passive ingestion and scheduled recap regression suites. Run the full gate and reviews.

**Demoable acceptance:** native DM dispatch shows a saved draft, sends it byte-for-byte only on the valid next `confirm`, and records one send. Every invalidation/replay fixture records zero additional sends. A group message cannot confirm it. No actual group send is part of the fixture gate.

**Proposed commit:** `fix: enforce Operator confirmation for Fantasy broadcasts`.

### 5. Simplify the Supervisor prompt and close integration acceptance

**Goal:** reduce what Jamis must know about specialist internals after the runtime boundaries work, while retaining observable behavior and evidence standards.

**Critical files:** `src/mastra/agents/jamis.ts`, migrated specialist descriptions/instructions and invocation contracts, affected agent/channel/observability fixtures, this plan and the architecture record. Update glossary/ADRs only for actual accepted language or changed behavior.

**Work:** map existing Supervisor clauses to the boundary/owner that now supplies or enforces them before removing duplication. Jamis retains task ownership/composition, checks, final voice, source-to-claim requirements, honest gaps, and escalation behavior; specialist tool protocols and action-state handling live with their owners. Remove orphaned hooks/imports/legacy response envelopes created by this migration. Keep adaptive reasoning and existing task limits; do not add a router, verifier agent, dependency language, or token-count target. Apply naming changes only to migrated interfaces, carrying all callers and historical telemetry mappings together.

**Verify:** run the concrete architecture walkthroughs through controlled native dispatch and compare behavior, not exact model wording. Exercise mixed account/research/weather requests, nested refusal, clarification/supersession, approval decline, verified creation plus draft, and action success followed by model/reply failure. Check exposed capabilities, no raw bypasses, safe trace/log/metric attribution, source/date/place requirements, and unchanged project/Monitoring/Incident/login/time-zone/scheduled Fantasy behavior. Run the final full gate, existing project Docker/CLI/lifecycle smokes, and all three reviews. Record actual totals, skips, demo evidence, and approved commits without borrowing historical test counts.

**Demoable acceptance:** the local native smoke and walkthrough fixtures pass with the simplified prompt. After separate deployment/live-test authorization, the Operator drives one step at a time through read-only weather/research, clarification, and the issue-plus-text-draft flow; inspect the exact created issue and verify replay cannot recreate it. A real broadcast requires separate explicit authorization of its exact text/group; do not send to a live group merely to close this plan. Confirm task outcome and channel acceptance separately, without claiming handset delivery.

**Proposed commit:** `refactor: simplify Jamis around typed execution boundaries`.

## Completion and tracking handback

The local implementation is complete only when all stages have their own approved commit and current verification evidence, each migrated specialist has one enforced typed entry path, both requested-action gates are runtime-enforced, and the concrete Linear continuation preserves effects and eligibility across the tested failures. Production acceptance remains separate until an authorized rollout and live observations are recorded. Unsupported general continuation and existing unrelated tool-name debt must not be described as delivered.

JAM-77 now carries the reviewed scope and acceptance observations, preserving its original mega-prompt/determinism motivation. The Operator authorized its update, branch creation, and the documentation commit/push, then handed Stage 1 implementation to a new session. Implementation-stage commits, pushes, deployment, and later ticket/subissue changes retain their existing authorization boundaries; none is authorized merely by writing this plan. Stage 1 must stop after verification/reviews for explicit commit sign-off before Stage 2 begins.

## Research basis and limits

The repository exploration traced current callers, durable records, tests, and telemetry mappings. The Mastra pass used installed docs/types/source; manual constructor injection is source-supported but still requires stage 1 integration proof. General-web evidence corroborated the design rather than adding new requirements:

- Keep orchestration small and use defined workflows for predictable sequences: [Anthropic's Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) and [OpenAI's practical guide](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/).
- Test re-entry and external effects independently of invocation success: [LangGraph execution guidance](https://docs.langchain.com/oss/python/langgraph/graph-api#re-execution-and-idempotency) and [Temporal Activities](https://docs.temporal.io/activities). Their replay guidance does not establish a Linear idempotency API or permit automatic retries here.
- Constrain the impact of untrusted content as well as filtering it: [OpenAI's prompt-injection guidance](https://openai.com/index/designing-agents-to-resist-prompt-injection/). Structured shape and a private sentinel check are useful evidence, not proof of universal semantic privacy or model immunity.

Perplexity discovery was rate-limited; Firecrawl Search used the same three query intents, followed by selected-page extraction. Existing APOSD/Anthropic/LangGraph sources were reused. Source caches are ignored under `.firecrawl/`; do not commit them. No new provider dependency, infrastructure, model choice, approval timeout, or standing authority is inferred from comparative research.
