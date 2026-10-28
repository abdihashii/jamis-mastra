# Fantasy Football Pundit and the editorial recap workflow

Status: accepted and implemented through the Stage 6.2 cutover, with final commit/deployment and integrated live acceptance separately gated in [plan 032](../plans/032-fantasy-pundit-editorial-workflow.md). That plan records the resolved implementation policies, native fixture verification and earlier deployed no-send acceptance. This ADR grants no publication or cron-resumption authority; the production recap cron remains Operator-paused. Historical context and the original gate list below explain the decision, not current unresolved implementation status.

## Historical context at decision time

Fantasy already has a Mastra agent, not just deterministic functions. `src/fantasy/generate.ts` constructs `fantasy-agent`; `src/mastra/index.ts` registers it as `fantasy`, without channels. The scheduled workflow calls `daily.ts` and `coordinator.ts`. Code selects high-score, low-score and closest-matchup awards; the agent supplies limited structured story prose. `week-facts.ts` also produces standings and retrospective player/bench comparisons. Those comparisons alone do not prove a manager made a bad decision with the information available before kickoff.

The existing system supplies important boundaries to retain:

- [ADR 0017](0017-fantasy-group-is-passive-channel-context.md): one Sendblue ingress, Operator DMs to Jamis, configured Fantasy group messages archived without agent invocation, other conversations ignored.
- [ADR 0018](0018-durable-recap-state-owns-delivery-correctness.md): one durable league/week delivery owner, atomic claims, saved final text, recorded send attempts, explicit uncertain outcomes and Operator recovery.
- [ADR 0009's typed amendment](0009-jamis-as-mastra-supervisor.md#typed-execution-boundaries-jam-77-2026-10-10-utc) and [plan 029](../plans/029-jamis-agent-architecture.md): checked internal invocation, scoped context, application-owned authority, specialist handback distinct from task completion and external effects.
- [Plan 025](../plans/025-alexandria-research-sources.md): bounded Alexandria discovery, inspected contracts/prices, attributable retrieved evidence, explicit gaps, no automatic terms acceptance or provider fallback. Its implemented sources are papers and developer records, not NFL capabilities.

The accepted product now requires genuine editorial selection: management awards, the most compelling matchup, an attributed exact quote, worthwhile stories and relevant supported NFL reporting. The [Fantasy Football Pundit product specification](../fantasy-football-pundit.md) supplies the goal, personality, recap criteria and report template; this ADR records the architectural consequences rather than recreating them.

## Decision

### One domain owner, a workflow, and bounded capabilities

Introduce **Fantasy Football Pundit** at `src/mastra/agents/fantasy-football-pundit.ts` as an internal, channel-less Domain specialist. It evolves the existing recap agent's responsibility; it is not a second competing recap writer. The Pundit owns editorial selection, interpretation, drafting and revisions, not publication authority or transport correctness.

Move supporting domain, integration, analysis, evidence, validation, rendering and persistence code from `src/fantasy` to `src/lib/fantasy`. Keep Mastra agents in `src/mastra/agents` and orchestration in `src/mastra/workflows`. Adapt every affected caller, script, test, fixture, import/export and active documentation reference, including ingestion, requested broadcasts, Monitoring and Incident triage. Preserve historical evidence when updating paths; do not rewrite old acceptance records as if they tested the new behavior. This is relocation and focused evolution, not a replacement data layer.

The weekly workflow composes pure functions wherever possible and explicit effect steps where required. Reuse existing durable records and checked invocation infrastructure. Do not introduce a general task engine, parallel state ledger, provider registry abstraction or dynamic workflow language.

**Broadcaster** is an accepted Capability specialist, including in this initial delivery. It receives an exact saved artifact or its reference plus a runtime-validated destination and authorization. It uses deterministic transport and reports the checked outcome. It cannot rewrite, summarize, research, select a destination, infer permission, or declare success from its own prose. Pundit recaps and future power rankings can use this capability; a rankings product/rubric is not part of this decision.

The current `fantasy-broadcast-agent.ts` is an Operator-requested **drafter**. Do not route approved recap text through it for another writing pass, duplicate it, or weaken its existing review path. Initial Broadcaster delivery targets only the existing configured Sendblue group. Renaming/consolidating the old drafter and implementing generic cross-channel broadcasting are deferred, not prerequisites. Exact factory/file/tool composition for Broadcaster is an implementation choice within these boundaries.

### Flow

```text
Scheduled trigger
  -> identify newest completed fantasy week
  -> no eligible new/retryable work? stop with the durable outcome
  -> atomically claim the league/week run
       saved final text exists? -> authorized saved-text delivery, no regeneration
       otherwise:
  -> collect Sleeper results, lineups, standings and transactions
     + bounded archived Fantasy group context
  -> research relevant public NFL questions through Firecrawl Alexandria
  -> freeze a scoped evidence packet, with provenance, times and gaps
  -> Pundit selects awards/quote/stories and writes a structured recap
  -> deterministic validation
  -> separate editorial validation against the same evidence and draft
       issues? -> bounded, specific-issue revision by the same Pundit
                  -> rerun every validation gate
       unresolved/exhausted/failure? -> no publication
  -> render final report and enforce final payload constraints
  -> save exact final text under the current durable claim
  -> Broadcaster, with validated artifact/destination/authority
  -> deterministic transport and durable outcome recording
```

The existing schedule is a wake-up signal, not proof that a week completed or authority to bypass a claim. Preserve completion semantics, configured scheduling time zone and newest-completed-week recovery after downtime. Evidence and stored timestamps use UTC. Manual run/retry paths must reach the same enforced owners; preview remains nonpublishing and must not mutate recap/run state.

### Calendar closure and recap timing

The recap becomes eligible after ESPN's reporting period closes and all games are complete. Boundaries are queried from ESPN and stored in UTC. The daily scheduled run checks eligibility.

### Evidence and research

The evidence packet keeps distinct:

- Authoritative league/week facts, supported calculations, stable manager/player/matchup references and relevant transactions. Retain correct ties and win/loss outcomes independently of editorial award selection.
- Bounded archived messages with source IDs, original eligible text, mapped attribution and UTC times. Preserve the read window and coverage gaps; a bounded sample is not the entire week's conversation.
- Retrieved public NFL evidence with original provenance, supporting content, publication/as-of times when available, retrieval time, attribution and limitations.
- Missing, unavailable, stale, truncated, malformed or partial evidence. Do not flatten these states into an empty successful result.

The reporting window is deterministic collection code, never a model-selected cutoff or agent-facing tool ([plan 033](../plans/033-deterministic-fantasy-reporting-windows.md)). Query the target and adjacent provider calendar periods, cross-check actual game membership/completion, and freeze the verified UTC bounds plus provenance on the attempt and packet. This is a provider-defined calendar period, not an actual final-whistle timestamp. One inclusive-start/exclusive-end interval governs original chat times, provable transaction completion bounds and admitted news publication/version times; later or unverifiable article versions are withheld. Requested-week scores/corrections and injury/result observations remain distinct from retrieval time and claims about pregame knowledge. Missing/conflicting boundaries block rather than fall back to collection time. Existing saved artifacts and exhausted-attempt holds are not silently rebased.

Research receives only application-projected public NFL identities and relevant time bounds. No private raw chat, manager names, phone numbers, league context, account context or Operator DM history may enter public queries. Private chat and public news are untrusted evidence, never instructions, caller identity or authority. The Pundit receives scoped evidence, not persistent Operator DM memory; it does not inherit Jamis's channel/session or personal-account context.

Use Firecrawl Alexandria for relevant NFL research, extending the existing bounded source pattern rather than exposing arbitrary catalogue execution. The [Alexandria fantasy-football article](https://www.firecrawl.dev/blog/alexandria-fantasy-football) describes injury/practice reports, news, rankings/projections and past projected-versus-actual data, with discoverable shapes and prices. It is a capability lead, not verification of exact contracts, access, costs or historical availability in this deployment. Preflight must inspect and exercise the selected contracts under separately authorized conditions before production dependence. Existing paper/developer prices and limits do not establish an NFL budget or authorize spending.

Pre-kickoff judgment requires evidence that actually describes what was knowable before the relevant decision. Today's projection, current injury status, a retrospective bench score, or retrieval time cannot establish past knowledge. Preserve unknown source dates. A past projected-versus-actual endpoint is not automatically a timestamped pre-kickoff snapshot. Transaction chronology, lineup eligibility and any claim that a swap was available require their own supporting evidence; never invent intent or an opportunity from final scores.

### Editorial policy

These decisions prospectively supersede [plan 030](../plans/030-fantasy-recap-structure-and-commentary.md) where it conflicts:

| Section | Accepted rule |
| --- | --- |
| Manager of the Week | Best actual management, considering start/sit decisions, recent acquisitions, resourcefulness and results. Not automatically the highest scorer. Judge choices against what was knowable before kickoff, without invented intent. If no standout decision is supported, recognize the strongest weekly performance and describe that basis honestly. |
| Loser of the Week | Most embarrassing supported management or performance, not automatically the lowest scorer. Defensible choices and injuries are not incompetence. Failed trash talk can strengthen an otherwise supported case, never supply the sole basis. If no standout management failure is supported, use the weakest weekly performance without inventing a mistake. |
| Match of the Week | Most compelling contest: supported suspense, high scoring, upset, stakes or group-chat context can matter. Not automatically the smallest margin. Code renders actual scores and margin. Do not invent lead changes, timelines, rivalries, projections or stakes. |
| Quote of the Week | An exact original message or one continuous excerpt, with known attribution and enough context. Select for humor, prophecy, hubris or timing, not reaction counts. Never stitch messages, fabricate wording or substitute a paraphrase as a quote. A genuinely empty week or an adequately reviewed window without a suitable quote says so explicitly. |
| Stories of the Week | Editorially worthwhile stories with headline and body. No fixed quota, forced matchup rundown, every-manager coverage or repetition of award explanations. Supported NFL news belongs only when relevant. Omission beats filler. |

The voice is dry and sharp in criticism **and** praise. Target fantasy decisions and performance, not personal circumstances. Keep reported facts distinct from editorial opinion; labeling a statement as opinion does not excuse a fabricated premise. Award basis remains explicit in the structured draft and checks, not a public “Basis” line or judging-policy disclaimer. An evidence-backed embarrassing performance can earn a sharp roast without inventing a bad management decision; proportionate harshness alone is not unfair.

Selecting an exact full message by source ID is the simplest quote default. If excerpts are implemented, code must verify a contiguous range of one retained original message, with exact attribution and no rewritten spelling, punctuation or interior omissions. Do not derive “exact” quotes from lossy whitespace-normalized/paraphrased context. Sensitive or out-of-scope material is ineligible; do not silently redact it into a purported exact quote. Reactions/Tapbacks are excluded.

This permits the selected, eligible attributed quote in the originating Fantasy group's report, a narrow exception to ADR 0017's blanket raw-chat-output prohibition. It does not authorize publishing transcripts, phone numbers, personal circumstances or unrelated private context, or forwarding any private chat to public research.

The old facts-only awards, paraphrase-only rule and blanket numeric-prose ban cannot remain the new editorial contract. Structured references and deterministic rendering still own verifiable numbers and names; expanded prose must have evidence-backed premises rather than gaining permission to invent numbers. Exact structured representation is an implementation gate. Historical high/low/closest calculations remain useful evidence, not mandatory editorial winners.

### Two validation gates, one writer

**Deterministic validation** checks schema and required sections, known league/week/subject references, source structure, supported structured numeric values, quote identity/range/attribution and reference resolution. It rejects missing or invalid structured output rather than treating prose or a fallback object as success. Code does not prove arbitrary prose semantically true, establish fair judgment, or determine whether a joke lands.

**Editorial validation** is a separate model invocation receiving the same frozen evidence and candidate draft. It reviews grounding, temporal support, award criteria, fairness, quote context, useful story selection, repetition and voice. It returns structured, specific issues tied to the affected content and evidence, not a replacement report. It is not a coauthor or publication authority, and model agreement is not proof of factual correctness.

Both gates are required before saving a publishable artifact or handing it to Broadcaster. Revision returns the specific issues to the same Pundit. Every revised candidate reruns both gates; changed evidence requires a newly identified evidence packet and full revalidation. The exact revision count, exhaustion behavior and per-call/time budgets must be accepted before implementation. No infinite loop, blind unlimited retry or fallback writer is authorized.

After validation, deterministic rendering resolves the approved structure and runs final payload/format checks. Any substantive alteration, including shortening or removing content, must return through the applicable drafting and validation gates. No model or transport layer may make unreviewed edits after final acceptance.

The historical 2,000-character, 180-word, twelve-sentence and zero-to-four-story limits are **not reapproved** for the expanded report. Total length, per-section limits, quote handling and single-message versus multipart delivery remain unresolved. Do not silently truncate awards/quotes, retain the old weakest-story dropping policy by accident, or split a saved message during sending. If multipart delivery is chosen, exact ordered payloads and partial-send recovery must be designed and verified before activation.

### Failure and partial evidence policy

The accepted invariant is no unsupported publication, not “always produce something.”

| Condition | Required behavior |
| --- | --- |
| No completed week, already sent, active competing claim or unresolved prior send | Return the existing no-op/blocked outcome; no new writer or outbound attempt. |
| Missing/invalid essential league facts, identity mapping or completion evidence | Block affected publication; do not fabricate results or select evidence-dependent awards. |
| Unavailable historical decision evidence | Withhold managerial blame/praise that needs it. The accepted performance fallback may be used only when sufficient performance evidence exists. |
| Empty eligible chat versus failed/truncated archive read | Keep them distinct. An outage cannot become “nobody said anything” or proof no suitable quote existed. |
| Missing/partial NFL evidence | Preserve useful independently supported findings and explicit gaps; omit unsupported claims. No model-memory substitute, route fallback, automatic terms acceptance or repeated uncertain provider execution. |
| Invalid draft, failed validator or exhausted revision budget | No publishable save or send; retain a safe failure under the existing lifecycle. A validator outage is not a pass. |
| Failed final formatting or artifact persistence | No send. Retry cannot bypass validation or storage ownership. |
| Possible provider acceptance with missing response/outcome persistence | Preserve `delivery_unknown`; Operator resolution is required before another send. |

The precise minimum evidence set and which noncritical gaps may permit a clearly limited report are implementation gates. In particular, whole-source outages and truncated chat need an explicit admission rule, not inherited silent degradation from today's `daily.ts`. Until that rule is accepted, the affected production publication path must fail closed. Partial specialist handback alone never authorizes publication.

### Models and invocation authority

| Responsibility | Accepted model policy |
| --- | --- |
| All model-backed new Fantasy recap analysis, NFL research, Pundit drafting/revision and editorial validation | GPT-6-Astra, xhigh |
| Broadcaster capability | GPT-6-Luna, max |
| Collection, pure analysis, deterministic validation/rendering, persistence and provider send | No model |

These are requested model/effort labels, **not executable provider IDs**. Verify the registry, configured gateway, supported reasoning values and structured-output/tool behavior before implementation; do not invent aliases or silently substitute models. Scope the Fantasy research configuration to these invocations; unrelated Research tasks retain their own model policy. Update `.env.example` and `.env.prod.example` only if actual configuration changes need documentation, never real secrets.

Follow the existing checked invocation boundary, not raw `Agent.agents`. Its current caller/target allowlists and public-question projection do not yet admit this schedule/Pundit/Broadcaster/NFL path. Extend only the concrete required edges, with trusted application-created caller authority, strict handback validation, fixed execution options, cancellation and explicitly projected callee contexts. Models and serialized request context cannot mint authority.

Attach internal specialists to the common Mastra runtime without making them public roots. Being channel-less does not itself prevent authenticated API access; root registration and API visibility require deliberate treatment. Retire the old recap writer registration when the replacement becomes active rather than leave a second bypass. Workflow registration, API authentication, a saved artifact ID or a successful model call cannot substitute for scheduled publication authority. Direct start/resume/tool paths must not synthesize it.

The scheduled policy supplies recap authority for the configured league/week/group. Operator-requested one-off broadcasts still require exact saved-draft review and the immediately following trimmed, case-insensitive `confirm` in the same active Operator DM. `decline`, another next reply or `/new` cancels it; altered text needs fresh review. Schedule authority cannot be borrowed for arbitrary requested messages. Never attach the singleton Sendblue adapter to Pundit or Broadcaster, and never give group messages command or confirmation authority.

### Durable delivery and privacy remain owned by code

Preserve the existing league/week lifecycle, atomic claims, stale-run recovery and outcome records. Save the exact final transport text before recording/performing the send. Any necessary plain-text conversion belongs before final checks and persistence, not after them: today's scheduled `sendToGroup()` applies `toPlainText`, so its current path is not proof of the new byte-preservation contract. Reuse/adapt the exact-send boundary rather than asking Broadcaster to copy text faithfully.

A transport retry reuses saved bytes, without research, award selection, drafting or editorial reapproval. New prompt/schema/model policy versions must not rewrite historical saved retry reports or erase generator-version history. Existing rejected or uncertain send outcomes retain their meaning. Framework replay, model retries or boot recovery must not bypass the durable claim; keep unsafe automatic action replay disabled. The longer research/review flow needs a verified lease/deadline policy so expired owners cannot publish.

Provider acceptance is distinct from handset receipt. A lost response may conceal a successful post, so there is no exactly-once delivery claim. Keep Operator `confirm-sent` and verified-absent recovery semantics, including stale-week protections. Broadcaster output is not an external-effect receipt unless validated against the actual durable/transport outcome.

Protect new independent workflow, Pundit, editorial, Fantasy Research and Broadcaster roots from their first telemetry event, not only when nested beneath Jamis. Carry safe trace/log/metric attribution, numeric usage, failure classification and historical component identities through Monitoring and Incident triage. Do not export raw evidence, quotes, prompts, reports, phone numbers, credentials or executable authority. Private storage and snapshot contents need explicit minimization; telemetry filtering neither deletes stored evidence nor makes snapshots an authority source.

## Alternatives and tradeoffs

- **Leave the generator as flavor-only code:** smaller change, but cannot implement genuine editorial awards and an exact quote. Moving its file without changing its contract would not deliver the accepted product.
- **Let one unconstrained agent research, judge, write and send:** fewer visible steps, but mixes evidence, publication permission and non-idempotent effects. A workflow with checked invocations makes these boundaries executable.
- **Use the old broadcast drafter as delivery/coauthor:** reuses a misleading name while creating a second writer and risking reviewed-byte changes. Keep drafting and exact-artifact delivery distinct.
- **Use deterministic checks alone:** cheap and reproducible, but cannot evaluate arbitrary prose grounding or fair judgment. Editorial review adds latency, cost and another failure point; it remains fallible.
- **Use a validator to rewrite until satisfied:** creates competing authors and unbounded work. Specific issues return to one Pundit under an explicit finite budget.
- **Build generic cross-channel orchestration now:** speculative complexity. Initial configured-group delivery proves the accepted capability without a destination framework or new ledger.

## Consequences and implementation gates

This is an editorial expansion and controlled migration, not a greenfield agent or permission expansion. The workflow becomes more expensive and slower; evidence gaps may prevent a report. Pure calculations, stable references and existing durable owners reduce risk, but do not remove model judgment or uncertainty after a send.

Before activation, [plan 032](../plans/032-fantasy-pundit-editorial-workflow.md) must resolve and verify:

1. Exact model/provider/gateway bindings and effort support for every model-backed Fantasy role, including scoped Research configuration.
2. NFL capability contracts, access/terms, provenance, historical/as-of availability, finite retrieval and cost budgets; Sleeper transaction/lineup evidence adequate for the intended decisions.
3. Evidence windows, freshness and partial-publication admission; exact schemas, numeric-reference representation, quote-range semantics and editorial tie handling.
4. Finite revision count, issue contract, failure/exhaustion handling, deadlines and claim-lease behavior. A bounded in-attempt revision must not become unlimited immediate regeneration through another entry path.
5. Final report budgets and formatting, single versus multipart delivery and any required partial-send recovery. No old budget is silently inherited.
6. Internal runtime composition, scheduled/manual caller grants, direct API admission, final-byte persistence/transport equality and historical retry compatibility.
7. First-event telemetry protection, source-context isolation and updated callers/scripts/tests/docs. Acceptance needs controlled failure/replay fixtures and representative no-send editorial samples; later live calls or sends require separate authorization.

Power rankings content/rubric, cross-channel destinations, group commands, reaction popularity, persistent Pundit conversation memory, additional infrastructure and general task/approval ledgers remain deferred.

## Evidence consulted and limits

This ADR is grounded in the current `src/fantasy` generation/analysis/Sleeper/rendering/ingestion/coordinator/daily/delivery/run/generation-history/broadcast/configuration modules, `scripts/fantasy-recap.ts`, Mastra composition and specialist invocation, the current Research source boundary and `src/mastra/observability.ts`, plus the linked prior decisions/plans. Their current behavior is not acceptance evidence for this proposed workflow.

For framework composition, installed `@mastra/core@1.71.0` documentation supports [workflow steps](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-overview.md), [agent/tool calls within steps](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-agents-and-tools.md), [structured output](../../node_modules/@mastra/core/dist/docs/references/docs-agents-structured-output.md) and the [Agent runtime configuration](../../node_modules/@mastra/core/dist/docs/references/reference-agents-agent.md). Existing native invocation code and ADR 0009 supply the stricter application contract. Framework support does not prove authorization, hidden registration, semantic correctness, exact payload preservation or safe replay in the new integration.

No new model/provider contract, historical NFL coverage, database behavior, rendered sample or delivery path was exercised for this documentation change. The cited article is contextual evidence supplied by the design discussion, not a new live preflight.
