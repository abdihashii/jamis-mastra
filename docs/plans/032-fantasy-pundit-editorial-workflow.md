# 032: Fantasy Football Pundit editorial workflow

Status: **Stage 1 complete. Stages 2–6 pending.**

Product authority: [Fantasy Football Pundit specification](../fantasy-football-pundit.md). Design authority: [ADR 0023](../adrs/0023-fantasy-pundit-editorial-workflow.md). Existing boundaries: [ADR 0009 typed execution amendment](../adrs/0009-jamis-as-mastra-supervisor.md#typed-execution-boundaries-jam-77-2026-10-10-utc), [ADR 0017](../adrs/0017-fantasy-group-is-passive-channel-context.md), and [ADR 0018](../adrs/0018-durable-recap-state-owns-delivery-correctness.md). Terminology belongs to [Jamis CONTEXT](../CONTEXT.md), [Fantasy CONTEXT](../../src/lib/fantasy/CONTEXT.md), and [CONTEXT-MAP](../../CONTEXT-MAP.md). Their path migration is implementation scope, not evidence that code has moved.

## Scope and non-goals

Implement ADR 0023's internal, channel-less **Fantasy Football Pundit** by moving and evolving the existing recap Agent into `src/mastra/agents/fantasy-football-pundit.ts`. Move support code/tests/fixtures from `src/fantasy` to `src/lib/fantasy`. Compose pure functions and explicit effects in the scheduled workflow: attributable evidence, targeted Alexandria NFL research, Pundit drafting, deterministic checks, separate editorial review, bounded revision, final rendering/storage, then checked **Broadcaster** delivery.

Initial Broadcaster delivery to the configured Sendblue group is in scope, not deferred. Power rankings content, cross-channel destinations, renaming/consolidating the Operator drafter, new webhooks, persistent Pundit memory, generic task/node frameworks, extra effect ledgers, per-award agents and speculative dependencies/services are not. Preserve the one-off Operator draft/confirmation flow and existing once-per-week delivery owner. ADR 0023 owns policy and rationale; this plan owns sequencing and verification.

## Existing state, checked against current code

| Boundary | Current behavior and consequence |
| --- | --- |
| `src/fantasy/generate.ts` | Already defines `createFantasyAgent`, runtime ID `fantasy-agent`, generator v10, model `openai-codex/gpt-6.1-sol` with `xhigh`. Its structured output contains stories only. Evolve this Agent rather than adding a competing writer. |
| `src/mastra/index.ts` | Registers it under `fantasy`; no channels are attached, but it is a registered root. New internal composition must deliberately remove that root at cutover, not equate channel-less with API-private. |
| `workflows/fantasy-weekly-recap.ts`, `fantasy/daily.ts` | One scheduled step calls the same daily flow as the CLI. Cron is `0 10 * * *`, with the configured recap timezone. Preserve scheduling semantics; evidence timestamps remain UTC. |
| `sleeper.ts`, `analysis.ts` | Normalize results, lineups, player points and championship-path brackets; reconstruct regular-season standings. Current player candidates are top starters and retrospective same-position bench flips. There is no transaction reader or verified pregame projection/injury history. A bench scoring counterfactual does not establish a bad decision. |
| `generate.ts`, `render.ts` | High/low/closest facts select awards. Stories have the old four-story, twelve-sentence, 180-word and no-number/paraphrase-only restrictions. Rendering removes whole trailing stories to fit 2,000 characters. These are historical behavior, not the approved expanded report contract. |
| `ingest.ts`, `toChatContext` | The existing webhook archives the configured group without invoking an agent. Context currently excludes unmapped senders, bounds input to 200 messages/20,000 text characters, joins text parts and trims them. Exact quotes require an immutable original-text path, not that normalized callback text. |
| `daily.ts`, CLI preview | Daily chat-read failures currently become empty context; preview throws. The scheduled window starts after the prior sent recap, while preview currently reads bounded messages without that anchor. New coverage and shared evidence assembly must distinguish unavailable, empty and truncated input. |
| `coordinator.ts`, `runs.ts`, `recaps.ts` | Claim the league/week before loading detailed facts, retain final text before an attempt, and own failure/unknown/sent transitions. Stored-text retries skip generation. Generation history is keyed by league/week/version/model. Preserve that authority and prior-version rows. |
| `deliver.ts` | Scheduled `sendToGroup` applies `toPlainText`; `sendExactToGroup` already exists for reviewed Operator drafts. Both disable SDK retries and have a deadline. A new exact-quote report must not be silently normalized between review, saving and transport. |
| `fantasy-broadcast-agent.ts`, `broadcast.ts`, `sendblue.ts` | The internal agent writes a one-off draft. Application code posts exact review and requires the immediately following trimmed, case-insensitive `confirm` in the same active Operator DM/session. It is not the requested saved-report Broadcaster. |
| `invoke-specialist.ts`, `specialist-invocations.ts` | Checked native tools already enforce caller identity, structured handback, fixed options, isolated contexts and revocation. Their only current workflow caller is `prepare_linear_reply`. Add the recap's explicit caller edges, not raw `Agent.agents` or an unrestricted workflow allowance. |
| `research-sources.ts` | Installed Firecrawl integration supports finite paper/Developer operations, not NFL sports contracts. Reuse its dependency and contract/pricing/provenance discipline, not its operation names or numeric budgets as assumed NFL support. |
| `observability.ts`, Monitoring/Incident tools | Direct-entry protection and historical lookup depend on exact IDs. The current protected-root list includes the Operator broadcast drafter, not every scheduled Fantasy root. Each new or migrated direct root needs protection from its first event, including CLI and workflow entry. |

Read together with [plan 025](025-alexandria-research-sources.md), [plan 029](029-jamis-agent-architecture.md), and [plan 030](030-fantasy-recap-structure-and-commentary.md). Their recorded test counts and live observations are historical evidence only.

### Framework and model evidence

Installed manifest: `@mastra/core@1.71.0`, `@mastra/pg@1.27.1`, `@ai-sdk/openai@3.0.88`, `firecrawl@4.41.0`. The Mastra skill and installed [workflow overview](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-overview.md), [agents/tools in workflows](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-agents-and-tools.md), [generate reference](../../node_modules/@mastra/core/dist/docs/references/reference-agents-generate.md), [structured output](../../node_modules/@mastra/core/dist/docs/references/docs-agents-structured-output.md), [request context](../../node_modules/@mastra/core/dist/docs/references/docs-server-request-context.md), and [error handling](../../node_modules/@mastra/core/dist/docs/references/docs-workflows-error-handling.md) support native steps, direct checked generation, strict output and explicit retry control. `AgentConfig.mastra` is present in installed types. Existing native-service fixtures prove the local shared-runtime pattern, not this future composition.

Use that common runtime for internal agents and expose only intended roots/workflows. Strict schemas prove shape, not truth. Reject missing output and native validation-error values; do not parse prose into success or add a fallback structuring model. A workflow can return `success` after `bail()`, so inspect the domain outcome. Disable automatic active-run restart and workflow/step retries on the effect-bearing procedure; native snapshots and cancellation do not replace durable send eligibility.

Requested models are **GPT-6-Astra, xhigh** for all recap model-backed Pundit, NFL-research and editorial-review work, and **GPT-6-Luna, max** for Broadcaster. Do not change unrelated Research defaults. Local, read-only registry inspection lists `gpt-6-astra` and `gpt-6-luna` under `openai`; the custom `openai-codex` gateway advertises only `gpt-5.6-terra`, although its resolver accepts a model ID. The installed Responses option accepts a reasoning-effort string. Neither fact verifies the requested subscription-backend model IDs or effort support. Resolve exact provider-qualified IDs and reasoning behavior in Stage 2; do not guess an alias, silently lower effort, or switch providers. No live model/provider request was made for this plan.

## Implementation invariants

Follow [ADR 0023's flow](../adrs/0023-fantasy-pundit-editorial-workflow.md#flow), [editorial policy](../adrs/0023-fantasy-pundit-editorial-workflow.md#editorial-policy), [validation contract](../adrs/0023-fantasy-pundit-editorial-workflow.md#two-validation-gates-one-writer) and [failure rules](../adrs/0023-fantasy-pundit-editorial-workflow.md#failure-and-partial-evidence-policy). Acceptance must demonstrate:

- One existing league/week claim before detailed evidence/model work; newest-completed-week recovery; no second lifecycle. Saved text skips research, writing and review on retry. `delivery_unknown` requires Operator resolution through existing recovery commands, never automatic resend.
- Public research receives only application-projected NFL identities/time bounds, never raw chat, manager identity, league/group context or Operator memory. Every evidence item retains source/time and distinguishes current/postgame information from verified pregame support. The supplied [Alexandria article](https://www.firecrawl.dev/blog/alexandria-fantasy-football) is a capability lead, not a sports contract or historical-coverage guarantee.
- Fixtures distinguish editorial selections from automatic high/low/closest awards; demonstrate the accepted performance fallbacks; reject invented intent, hindsight/injury blame, unsupported score timelines/stakes and trash talk as the sole award basis. Review covers dry, fair praise/roasting and distinct headline/body stories without quotas or manager balancing.
- Quote selection uses immutable source ID and code-resolved exact attribution/text, with a verified continuous range only if excerpts are implemented. No reactions, personal disclosures, stitched wording or normalization. Adequate evidence with no suitable quote is explicit; unavailable/truncated chat is not falsely reported as empty.
- Both validation gates pass against the same frozen evidence and candidate. Review returns specific issues, not replacement prose. Revisions go to the same Pundit and repeat every gate; missing review or exhausted budget blocks publication. Model review does not guarantee facts.
- Resolve names, quotes and numbers into a deterministic candidate before review. Final rendering must reproduce that publishable artifact; semantic shortening/removal requires renewed review. Neither transport nor Broadcaster may silently rewrite it.
- Save exact final text under the active claim before Broadcaster. Its narrow tool validates saved reference/text and configured target, while the coordinator records the attempt before transport and the outcome afterward. Preserve actual effects even if later model output fails. A model-authored receipt is not transport evidence.
- Keep scheduled authority separate from exact Operator draft/next-message confirmation. The existing drafter is not an extra recap writing pass. Preserve archive-only group ingress, internal shared-runtime composition, isolated memory, first-event telemetry protection and historical IDs.

## Decisions still required before implementation crosses their boundary

| Gate | Required decision or evidence |
| --- | --- |
| Model contract, Stage 2 | Exact provider-qualified Astra/Luna IDs, `xhigh`/`max` support, strict structured output and required tool combinations through the installed gateway. Local registry/type acceptance is insufficient backend proof. Obtain separate approval for any bounded live probe. |
| Alexandria contract and spend, Stage 2 | Concrete sports operations, read shapes, identifier mapping, historical season/week availability, licensing/terms, maximum per-call/task cost and call bounds. Discover before assuming handles; fixtures cannot establish current upstream coverage. |
| Historical and partial evidence, before Stage 3 acceptance | Evidence windows/freshness and which gaps allow a narrower recap versus blocking the week, including unavailable pregame history, transactions, player data or archived chat. Define gap disclosure and when performance fallbacks are justified; never use current rankings/injuries as historical pregame facts. |
| Editorial structure, before Stage 4 implementation | Required schema, numeric-reference representation, quote/full-message versus continuous-excerpt handling and editorial tie treatment. Preserve factual ties without inheriting the old automatic award-selection contract. |
| Output size and transport, before Stage 4 schema/final-render implementation | Expanded-report length and section budgets, single message versus splitting, ordering and exact-text preservation. If splitting is chosen, approve partial-send/unknown-part recovery under the existing delivery owner and revise Stages 5/6's single-payload acceptance before proceeding. The old 2,000 characters, 180 words/twelve sentences, four stories, no-number prose and paraphrase-only labels are not new limits. |
| Revision/failure policy, before Stage 4 loop implementation | Numeric revision/cost/time budget, what terminal editorial block records, safe Operator notification and whether/when later wake-ups may reconsider a blocked draft. Do not silently reset an exhausted budget every day. No speculative general retry system. |
| Evidence/history retention, before Stage 6 persistence | Minimal private evidence/review/version metadata needed to audit the final artifact, failed-candidate retention and safe diagnostic policy. Preserve existing reports, old facts shapes and exact saved retry text. No historical rewrite, purge or public raw-chat export. |

These unresolved items do not reopen accepted specialist roles, two validation gates, the requested model families/efforts, passive ingress or durable delivery ownership. Unless an explicit partial-publication admission rule is accepted, affected publication fails closed. Stop at the affected boundary and get the decision; do not manufacture defaults in a schema or silently ship degraded coverage.

## Independent delivery slices

This change spans a source integration, privacy boundary, editorial domain behavior and a new test surface. Separate their risk before activating sending:

1. **Behavior-preserving relocation, Stage 1.** Move the existing implementation and extract its existing Agent definition. Demo: identical fixture recaps, unchanged delivery transitions and working imports without provider calls.
2. **Source/model contract proof, Stage 2, then attributable evidence, Stage 3.** Highest-risk new concern comes before editorial dependence. Demo: bounded NFL-only discovery/read fixtures produce attributable evidence or explicit gaps; private sentinels never reach provider inputs. Live contract/history proof remains separately authorized.
3. **Validated no-send candidate, Stage 4.** Demo: one frozen fixture produces a complete reviewed artifact, while unsupported quotes, hindsight accusations and exhausted revisions block it; preview makes no recap/run mutation or transport attempt.
4. **Saved-report delivery boundary, Stage 5, then one controlled cutover, Stage 6.** Demo: a controlled saved-report handoff makes one exact-byte SDK attempt, duplicate/uncertain paths stop, and the integrated preview still cannot publish.

Each slice has an independently observable outcome. Until Stage 6, the currently active scheduled path stays intact and pinned to its existing contract. Candidate code is reachable only through explicit local preview/test composition, never a second active schedule or partially validated send route. Use temporary compatibility only to preserve that boundary, remove it at cutover, and do not turn it into a permanent multi-version agent framework.

## Numbered implementation stages

Every stage below is separately committable, but none is authorized by this document. Paths for new tests/modules are proposed, not existing APIs. The full repository gate and reviews below apply to **each** stage, in addition to its focused checks. Show the diff summary, evidence and proposed commit; wait for explicit user **ok before committing**, then begin the next stage. Push, deployment, live model/source calls, private-data reads and sends require their own authorization.

### 1. Relocate Fantasy support without changing behavior

**Status: complete.**

- Committed and pushed: `0125dee`, `5a20844`, `c7b89c1`.
- Verification: 518 tests passed, 1 Linux-only skip; typecheck, lint, build and infra passed.
- GPT-6-Astra xhigh `review-code` and `ponytail-review`: no findings.
- Real-data no-send preview and inspection passed. No iMessage delivery test performed.

**Goal:** establish the accepted file ownership without changing the active recap, Operator draft flow, models or delivery state.

**Critical files:** all `src/fantasy/*.ts`, `__tests__` and fixtures; new `src/lib/fantasy`; `src/mastra/agents/fantasy-football-pundit.ts`; `src/mastra/index.ts`; `scripts/fantasy-recap.ts`; imports in Jamis, the broadcast drafter, Sendblue, scheduled workflow, Monitoring, Incident triage and deployment-evidence tools/tests. Include `src/fantasy/CONTEXT.md`, `docs/CONTEXT.md`, `CONTEXT-MAP.md` and affected documentation links.

**Work:** move deterministic domain, integration, analysis, prompt/evidence shaping, rendering, validation, persistence and coordination together. Extract the existing Agent construction into the accepted agent file; preserve its model, shaping and delivery contracts, subject to the identity amendment below. Move shared voice text without changing the Operator drafter's contract. Update static and dynamic imports, script fixtures and links in the same stage. Do not rename SQL tables, archive threads or historical IDs. Retain historical plan wording while making maintained links resolve to the new paths; do not bulk-rewrite historical evidence as if it described the new pipeline.

**Verify:** relocated analysis/generator/coordinator/delivery/ingest suites, native broadcast/session fixtures, Monitoring/Incident consumers and full gate. Search all callers and stale source paths, including test subprocess strings and dynamic imports. A path-only change does not bump the generator version.

**Demo:** `rtk bun test src/lib/fantasy/__tests__/generate.test.ts src/lib/fantasy/__tests__/coordinator.test.ts` renders the same synthetic report text and preserves saved-retry/unknown-send assertions. Inspect the complete fixture text and import graph; zero provider calls.

**Identity amendment (Operator-approved, 2026-10-15 UTC):** use runtime ID and registration key `fantasy-football-pundit`, display name Fantasy Football Pundit, and factory `createFantasyFootballPundit`. Replace the ibn Jamis persona in active recap/broadcast instructions. This changes prompt identity, so bump the generator to v11 while retaining the existing model and facts-only shaping contract; historical saved reports are not rewritten. Keep legacy `fantasy-agent` telemetry lookup and protect the renamed root from its first event. The root remains registered until the later internal-only cutover. The Operator also approved fixing the affected native broadcast fixture's pre-existing broken relative imports.

**Verification snapshot (2026-10-16 UTC):** relocation, extraction and the identity amendment are implemented. The Operator's lint fixes were preserved and the authorized repository lint cleanup is complete. SQL test fakes, assertions and fault injectors now tolerate formatting whitespace; unconfigured fixtures no longer inherit ambient Fantasy configuration.

| Check | Observed result |
| --- | --- |
| Typecheck, infra, whitespace | Pass; 4 infra tests |
| Focused Fantasy/Agent/tracing suites | 133 pass; additional incident identity schema check passes |
| Native broadcast/session/provider-schema contracts | 12 pass against disposable loopback PostgreSQL |
| Full suite | 505 pass, 0 fail, 1 Linux-only mount smoke skip (506 tests across 52 files) |
| Full lint | Pass: 0 errors, 206 line-length warnings; rules unchanged |
| Build | Default `bun run build` passes, including dependency installation and Studio; no skip-install flag |
| Read-only review | Four fresh final lanes (correctness, contracts, security, integration/Ponytail): no findings |

Tests used fixture credentials and an OS-level external-network deny allowing only loopback and local Unix sockets. The default build used separately approved build-only network access, fixture credentials, empty HOME and disabled telemetry. No live models, provider sends or production database operations. **All repository gates and final reviews pass without a baseline exception. The Operator approved committing and pushing Stage 1, including the gate repairs.** Deployment and the live no-send preview remain Operator-run acceptance checks.

**Gate repairs (Operator-approved, completed 2026-10-16 UTC):**

1. **Restore test fixtures, not production policy.** Critical files: the Sendblue/Linear, incident, Monitoring, current-time and Deployment evidence tests. Normalize SQL-fake/fault-injection whitespace and explicitly supply the disabled-league fixture. Allow local Unix sockets in the temporary verification sandbox while preserving external-network denial. Verify: full suite now 505 pass, 0 fail, 1 Linux-only smoke skip; typecheck and 4 infra tests pass. Proposed separate commit, if the diff can be isolated coherently: `test: make SQL fixtures independent of formatting`.
2. **Finish lint and verify the standard build.** Critical files: ESLint-reported source/tests/scripts; do not relax lint rules, alter package versions, or change runtime behavior. Preserve the Operator's earlier formatting work, apply autofixes, then minimally address any remaining errors. The Operator permits build-only network access for existing dependency installation with fixture credentials, empty HOME and telemetry disabled; tests remain externally network-denied. Verify: typecheck, full tests, lint, default build, infra and whitespace checks, followed by fresh read-only review. Proposed separate commit, where feasible: `chore: restore repository lint gate`.

These repairs satisfy the runtime gate prerequisites for Stage 1 acceptance. The Operator approved grouping them with Stage 1 in one commit; Stage 2 and merging remain unauthorized. Package manifests, lockfiles and lint rules remain unchanged.

**Approved commit:** `refactor: extract Fantasy Football Pundit and restore repository gates`.

**Live-smoke follow-up (Operator-approved for commit and push):** the week-5 no-send preview rejected a new sentence because it overlapped a prior recap in mapped chat. Read-only triage found four complete recap blocks in the last 200 archived messages. Exclude messages containing all three award headings on separate lines from model context, not from archival storage; retain ordinary award discussion and all existing copy/attribution checks. Bump the changed input contract to v12; do not rewrite historical reports or saved retries. This is one independently committable bug fix, not Stage 2.

The corrected preview also exposed a sentence-shape failure: preview bypassed the scheduled path's existing single repair, and that repair lacked feedback. Move validation and that same repair budget into shared `generate.ts`, feeding the rejected draft and exact issue only to the same writer with existing trace-content hiding. State the existing per-field sentence and four-word overlap rules explicitly. A second invalid candidate still hard-fails; no extra review model, retry loop or Stage 4 editorial-review machinery.

- **Goal/files:** shared context/repair ownership in `generate.ts`, used by `coordinator.ts`, `daily.ts` and the CLI; explicit Agent instructions; regression tests for context admission, unchanged archives, budgets, issue-aware repair, max-two calls, provider failures and valid-only persistence; version assertions and Fantasy CONTEXT.
- **Verify:** failing regressions reproduced before both fixes; focused 140/140; full suite 515 pass, 0 fail, 1 Linux-only skip (516 tests, 52 files); typecheck, lint (0 errors, 206 existing warnings), standard build, infra (4 tests) and whitespace checks pass. Three fresh final read-only correctness/contracts/privacy-Ponytail reviews returned no findings.
- **Live acceptance:** the final week-5 no-send preview passed on its first draft using the deployed image's Mastra 1.71.0 dependencies: v12, 761/2000 characters, 2 callbacks, 195 mapped messages; database counts stayed at 5 generations and 5 runs. The shared repair's two-attempt limit and failure paths are fixture-tested, not inferred from that successful first draft. A temporary source copy was used with auto-install disabled; production source remained at `0125dee`, the app was not restarted, and no packages, archived messages or saved reports were changed. The in-memory warning belongs to the intentionally ephemeral preview Mastra instance; archived chat was read separately through read-only PostgreSQL connections. Earlier source-runner probes used the VPS's older 1.61.0 dependencies and are not the final compatibility evidence.
- **Approval:** implementation and verification complete; the Operator approved committing and pushing this Stage 1 follow-up on the existing feature branch. Merging, deployment and Stage 2 remain unauthorized. No iMessage delivery test was performed.
- **Approved commit:** `fix: clean recap context and repair invalid previews`.

### 2. Prove NFL source, privacy and model contracts off the live path

**Goal:** establish the concrete source/model boundary before any editorial feature depends on it.

**Critical files:** installed registry/gateway/SDK evidence; existing `src/mastra/tools/research-sources.ts` and `agents/research-agent.ts` as reuse references; a narrow Fantasy NFL source module under `src/lib/fantasy`; `src/mastra/gateways/openai-codex-gateway.ts` only if a verified catalog correction is needed; focused source and provider-schema tests.

**Work:** resolve model and sports-contract gates above. Implement only demonstrated read-only sports operations using the installed Firecrawl SDK. Retain task-local inspected contracts, bounded prices/requests, attributable response parsing and explicit uncertainty. Runtime projection accepts trusted public NFL identifiers/time bounds, not model-authored private queries. Configure recap-only Astra research without changing unrelated Research callers/defaults. Reuse the checked Research contract where it fits; do not force sports records into a paper schema or build a provider registry.

**Verify:** local HTTP/SDK fixtures for discovered contracts, routing, malformed/empty/partial content, source dates, historical queries, unsupported player mapping, unknown/excessive charges, terms/access denial, timeout and request identity. Capture the real provider request shape with a controlled transport: model ID, reasoning effort, object-root schemas and fixed options. Verify private chat/manager/Operator-memory sentinels are absent from model research inputs, source requests and exported signals. No real secrets or paid calls in tests.

**Demo:** proposed `rtk bun test src/lib/fantasy/__tests__/research.test.ts` prints/asserts a normalized historical-versus-current evidence fixture and a denied private projection with zero upstream calls. Separately authorized discovery/read and model probes must record actual contracts/effort behavior before this slice is declared externally proven. If unavailable, report the blocker; do not pass downstream acceptance using invented fixtures alone.

**Proposed commit:** `feat: add bounded fantasy NFL research contracts`.

### 3. Assemble frozen league, chat and NFL evidence for preview

**Goal:** produce one reproducible evidence packet with explicit temporal and coverage limits, without report/run writes or publication.

**Critical files:** `src/lib/fantasy/sleeper.ts`, `analysis.ts`, extracted chat-context helpers, proposed `evidence.ts`, Stage 2 research code, `daily.ts`/`scripts/fantasy-recap.ts` evidence consumers and fixtures.

**Work:** add verified transaction/lineup evidence needed for the approved criteria, preserve deterministic results/standings, and separate retrospective performance from pregame decision support. Keep factual extremes as evidence/fallback inputs, not automatic award choices. Retain original archived quote text and immutable message/attribution references independently of normalized editorial context. Select only bounded mapped evidence; exclude personal disclosures from publishable quote candidates. Share evidence-window/assembly behavior between candidate preview and the future scheduled path, with explicit empty/unavailable/truncated distinctions. Freeze sources before drafting; do not introduce speculative historical snapshots or claim unavailable pregame coverage.

**Verify:** transaction status/time, legal roster alternatives and kickoff availability where supported; unknown timestamps, current-only data, ties/byes/playoffs, missing players and archived-chat failures. Cover exact full-message selection, continuous ranges if implemented, multiline/Unicode/Markdown-like text, attribution, unmapped senders and privacy rejection. Confirm inspect/preview do not initialize schema, mutate rows, alert senders, refresh DM memory or import an operational send path.

**Demo:** proposed `rtk bun test src/lib/fantasy/__tests__/evidence.test.ts` assembles a complete synthetic packet and a partial-history packet with explicit gaps. Compare their displayed UTC source times and quote bytes with fixtures. Mutation and send spies must stay at zero; all unsupported decision premises remain unavailable rather than being fabricated.

**Proposed commit:** `feat: assemble attributable fantasy recap evidence`.

### 4. Build the complete Pundit and editorial-review candidate path

**Goal:** prove the full editorial contract through no-send preview before changing the active scheduled generator.

**Critical files:** `src/mastra/agents/fantasy-football-pundit.ts`; Fantasy generation, rendering and validation modules; a small editorial-review module/invocation; `src/mastra/tools/invoke-specialist.ts` and trusted composition; `src/mastra/observability.ts`; `scripts/fantasy-recap.ts`; proposed editorial and CLI preview tests.

**Work:** resolve output-size and revision/failure decisions first. Evolve the same Pundit definition with the approved selections, source references, quote selection and headline/body stories. Use a separate tool-free Astra review invocation, not another writer or publicly callable verifier. Add explicit recap workflow caller edges through existing checked invocation machinery. Keep caller-controlled options, memory and ambient channel authority out; pin model/effort/limits at trusted construction. Protect direct roots before any prompt/error export.

Build deterministic candidate rendering before review, issue-specific feedback, the bounded loop and final artifact equality checks. Every changed draft repeats every gate on the same evidence. The existing scheduled composition remains pinned to its old contract until Stage 6; no candidate can reach persistence/delivery. Use only the minimum temporary compatibility needed, not two independently operating recap authors.

**Verify:** scripted native model fixtures for supported awards/fallbacks, genuine quote/no suitable quote, numeric/reference mismatch, fabricated chronology, injury/hindsight accusations, repeated stories, personal disclosures and source injection. Deterministic tests prove exact matching; scripted review cases prove rejection/feedback/control flow, not model judgment quality. Cover missing/malformed review, stale draft/evidence reference, exact revision-budget exhaustion, cancellation and final formatting overflow. Post-review trimming/normalization must fail rather than silently alter publication.

**Demo:** proposed `rtk bun test src/lib/fantasy/__tests__/editorial.test.ts src/lib/fantasy/__tests__/preview.test.ts` exercises actual candidate composition: one issue is repaired and re-reviewed, persistent issues block, and a valid artifact includes the exact fixture quote. Hard-block Sendblue SDK methods and all unapproved network paths before imports; assert zero group/DM attempts and zero report/run mutations. Preview with archived disposable storage must use read-only connections with initialization disabled and compare existing row contents as well as counts. Separately authorized real-model previews assess complete output against frozen evidence; they do not prove universal quality.

**Proposed commit:** `feat: validate fantasy pundit recap candidates before publication`.

### 5. Prove the narrow saved-report Broadcaster boundary

**Goal:** deliver an already approved saved report through the requested Capability specialist without rewriting or expanding send authority.

**Critical files:** proposed `src/mastra/agents/broadcaster.ts`; checked invocation/composition; `src/lib/fantasy/coordinator.ts`, `deliver.ts` and report-reference validation; native delivery/authority tests; observability and historical Incident mappings.

**Work:** construct internal Broadcaster with the verified Luna/max configuration and one narrow runtime-validated delivery operation. Bind exact saved report and allowed target in trusted application state; the model cannot supply arbitrary text, group IDs, claim tokens or approval fields. The coordinator owns attempt recording, transport and outcome storage. The tool exposes only the authoritative result and cannot attempt twice within one claim. Do not attach it to the active scheduled path yet.

Keep `fantasy-broadcast-agent.ts` as the one-off Operator drafter with its existing confirmation owner. Do not send recaps through `draft_group_message`, create another reviewed-draft record, or generalize destinations. An internal registry test must show no new public agent/tool route that can mint delivery authority.

**Verify:** saved/unsaved, changed text/digest, wrong league/week/group/version, stale/forged/serialized authority, unknown report reference, direct authenticated invocation, repeated tool calls and model-fabricated success. Verify byte-identical SDK payloads for quotes, whitespace, Unicode and Markdown-like content. Inject refusal/failure before dispatch and model failure after a recorded send; only the coordinator's actual effect survives as truth. Assert SDK retries disabled and no hidden chunk sends.

**Demo:** proposed `rtk bun test src/lib/fantasy/__tests__/broadcaster.test.ts` loads a synthetic saved report, makes one controlled SDK attempt with exactly its text, and rejects duplicate/altered/unauthorized requests. Live scheduler wiring is unchanged, all external transport is blocked, and the native Operator broadcast-confirmation suite still passes.

**Proposed commit:** `feat: add checked saved-report broadcaster capability`.

### 6. Activate one validated pipeline and close repository acceptance

**Goal:** switch scheduled and authorized CLI execution together, preserving durable ownership and exact saved-report recovery.

**Critical files:** `src/mastra/workflows/fantasy-weekly-recap.ts`, `src/mastra/index.ts`, Fantasy `daily.ts`, `coordinator.ts`, `runs.ts`, `recaps.ts`, `scripts/fantasy-recap.ts`; all affected native workflow/CLI/delivery tests; Monitoring/Incident/observability; glossary and context links; this plan and ADR 0023 evidence/status.

**Work:** resolve retention/history policy, bump the generator contract version, and add only necessary backward-compatible report/evidence/review metadata to existing owners. Claim-gate final publication storage and bind both successful gates to the exact persisted artifact. Failed candidates never become `final_text`. Move scheduling and CLI `run` onto one composition, remove temporary old-generation activation paths, and remove the old registered `fantasy` root while retaining historical ID lookup. Internal agents use the shared runtime; CLI must not import the production entrypoint and accidentally start its scheduler.

Retain one durable league/week owner and no second effect ledger. Revalidate claims around long research/review work and immediately before effect recording; account for the existing fifteen-minute lease when fixing bounded deadlines. Claim expiry/replacement must not let an old writer save or send. A saved report bypasses research, Pundit and editorial review on retry, including old versions. Preserve existing historical final text and recovery semantics; no migration rewrites saved messages. New reports use the verified exact-text transport path, not silent Markdown normalization.

**Verify:** actual native workflow plus disposable Postgres tests, not only an in-memory store. Cover concurrent daily/manual claims, repeated schedules, no completed week, newest-only recovery, stale leases/claim loss during research/review, report-save acknowledgement loss, crash before/after attempt recording, provider response loss, nonempty handle/acceptance validation, outcome persistence failure and post-send model failure. A saved retry must show zero research/writer/reviewer calls and byte-identical text. `delivery_unknown` blocks all automatic resend paths; explicit recovery and stale-week denial still work. Include legacy rows/generator versions, Operator confirmation regressions, passive ingestion, isolated memory, denied API start/resume/tool bypass, safe first-event traces/logs/metrics, usage attribution and historical IDs.

**Demo:** `rtk bun test src/mastra/workflows/__tests__/fantasy-weekly-recap.test.ts src/lib/fantasy/__tests__/coordinator.test.ts src/lib/fantasy/__tests__/preview.test.ts` must demonstrate one controlled accepted saved-report attempt, an unknown-send block with no second attempt, exact saved retry without regeneration, and read-only no-send preview. Inspect complete fixture artifacts and safe outcome records, not merely workflow `success`. A separately approved bounded archived-chat/model preview must prove unchanged report/run contents and zero SDK sends before any separately approved rollout or publication. Do not fabricate live webhooks/confirmation or replay an uncertain production send for testing.

**Proposed commit:** `feat: activate the validated fantasy pundit weekly workflow`.

## Repository gate, reviews and closeout

For each stage and again after final integration, run focused checks followed by the exact plan 030 repository gate:

```sh
rtk bun run typecheck
rtk bun test
rtk bun run lint
rtk bun run build
rtk python3 -m unittest discover -s infra -p 'test_*.py'
rtk git diff --check
```

Use deterministic fixture models, local provider responses and SDK-level transport interception. Tests must not require paid tools or real secrets. Where persistence contracts require it, point both `DATABASE_URL` and `JAMIS_TEST_DATABASE_URL` at disposable loopback `jamis_sessions_test`, never production. Test DB writes are an implementation-verification activity requiring later authorization; none are part of writing this plan. Block external network by default, including clients that capture `fetch` before a later stub. Plan 029's rejected synthetic Sendblue request demonstrates why a replaced global fetch alone is insufficient containment.

Run applicable existing architecture/project Docker/CLI/lifecycle smokes for runtime/composition changes, and at final integration. Report totals, exclusions, skips and failures. Plan 030 records a historical calendar SQL-connection failure and pending archived-chat acceptance; neither is assumed to describe today's checkout, waived as a new failure, or counted as passing this plan. A skipped DB contract is not persistence acceptance.

Use fresh read-only `review-code` and Ponytail review per stage; use `security-audit` for source privacy, caller authority, exact quotation, persistence and delivery changes. Resolve verified blockers before sign-off. A stage with a failing required gate is not complete. Stop after its diff/evidence/proposed commit for explicit commit approval; approval to commit is not approval to push or begin an unauthorized rollout.

Final closeout reruns the whole-repository gate, reconciles maintained glossary/CONTEXT-MAP links to `src/lib/fantasy`, records the final approved commit list and documents remaining live-quality/coverage limits. Retain old report history and historical telemetry mappings. Distinguish fixture control-flow acceptance, model sample quality, provider acceptance and Operator-observed receipt. No check here authorizes a live send merely to finish the checklist.

## Documentation-pass limits

This plan was grounded in current source, focused test code, full relevant ADR/plan records and installed framework docs/types, with local registry inspection only. No implementation, installs, model/provider execution, DB operation, send, commit, push or deployment occurred. Sports contracts/historical coverage, live requested model/effort behavior, expanded output limits and revision/failure/retention decisions remain explicit gates, not verified capabilities.
