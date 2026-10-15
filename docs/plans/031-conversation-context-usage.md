# JAM-76: On-demand conversation context usage

Status: Stages 1 and 2 delivered, reviewed and deployed, including the identity fixes at `c7efbd9`. Both authorized live routing smokes passed. Linear ACs 1 through 7 are complete; ACs 8 and 9 remain open as written because the complete regression/repository gates do not pass. Unrelated baseline repairs remain outside this ticket.

Tracking: [JAM-76](https://linear.app/abdirahman-haji/issue/JAM-76/ask-what-the-current-conversations-context-window-is-at).

## Current checkpoint

**Delivered commits:** `c6639f8` (request-local capture), `6a41cbb` (chat reporting), `c7efbd9` (model/trace identity fixes). All are pushed on `abdirahman/jam-76-ask-what-the-current-conversations-context-window-is-at`. Production was verified running `c7efbd9`; build, project CLI probes and runtime tool-registration checks passed.

### Live evidence on `c7efbd9`

- **Current context:** trace `d6d370aedab9a04dcac727d5fedf9824`, started `2026-10-15T00:04:44.504Z`. Named `conversation_context` call succeeded with zero error spans. The reply identified `openai-codex / gpt-6.1-sol` and reported `28051` input tokens, matching the call requesting the tool. The final-answer call used `28212`, confirming the earlier measurement is not the final or cumulative input count. The reply separately reported OM messages `14476/30000` and observations `0/40000`, explicit unknown capacity/percentage/headroom, and timing, estimate, compaction and output-capacity caveats.
- **Historical Monitoring:** trace `36f98cda423ffbd99fd5e2af92b0070d`, started `2026-10-15T00:06:24.860Z`. Only `checkMonitoring` executed, successfully, with zero error spans. The reply reported `275688` input + `7925` output = `283613` total tokens for `2026-10-14T00:06:26.935Z` through `2026-10-15T00:06:26.935Z`, with evidence available and no query gaps. This proves current-context routing did not replace historical Monitoring routing; the historical aggregate values are recorded from the reply, not independently re-queried.
- **Verification limits:** model capacity remains unverified and is intentionally unavailable. Protected traces omit tool outputs, so the live OM figures are reported values, not independently trace-verified counters. Native OM counting/interception is covered by deterministic tests. No extra diagnostic persistence was added.

### Acceptance and verification status

- **ACs 1 through 7: checked in Linear.** Supported by capture/tool/privacy/availability tests and the authorized real DM evidence above, not fixture success alone.
- **AC 8: open.** The actual registered-tool integration, schema/output and scoped delegation/provider checks pass. The complete criterion also requires existing Monitoring/session regressions to pass; baseline failures remain, and database-dependent coverage was skipped. Passing the new integration portion alone does not satisfy this combined AC.
- **AC 9: open.** Latest full suite: `429 passed / 14 skipped / 51 failed`, the same 51 failure names as baseline. Typecheck retains the same 20 baseline errors. Lint retains 579 findings (318 errors, 261 warnings). The repository gate is not green; deployment approval did not make this AC pass.
- **Scoped checks:** 23 focused tests passed. Build, four infra unit tests and whitespace checks passed. Independent GPT-6-Astra medium `/review-code` and `/ponytail-review` passes found no introduced issues in the identity fixes. Both fixes had observed RED failures before implementation, then GREEN checks.
- **Next decision:** ACs 8 and 9 need an explicit acceptance decision or separate resolution before claiming every AC is complete. Do not repair unrelated baseline code, relax checks, check these ACs, or close the issue merely because deployment and live smokes passed. Implementation/live-smoke todos are complete within the approved ticket scope; this is not full repository-gate acceptance.

The sections below retain the original plan and historical implementation checkpoints. This current checkpoint supersedes their earlier pending-status statements. Implementation evidence belongs in Linear comments, not additional delivery sections in the issue body.

## Agreed scope

The operator can ask Jamis in ordinary chat how much context the current conversation uses. Report two clearly separated measurements:

1. **Model context:** provider-reported input tokens for the latest completed Jamis model call in this request. Identify the model and measurement point. Never use cumulative run usage, historical Monitoring totals, or specialist usage as current context occupancy.
2. **Observational Memory:** current active message and observation token counts against their observation/reflection thresholds. Explain that these thresholds trigger memory compression, not model context exhaustion.

Report model capacity, percentage, and input headroom only when capacity is verified for the actual gateway/model. Otherwise explicitly report capacity and percentage as unavailable. Input headroom is not a guarantee about remaining output: reasoning/output and subsequent tool results also consume capacity.

The measurement precedes the answer: the call that requests the tool has completed, while the final answer has not. Missing provider usage is unavailable, not zero. OM counts use Mastra's own counting and may be estimates. Unavailable OM or usage must not suppress the other successful measurement.

No automatic warnings, compaction changes, context trimming, new dependencies, new services, persisted usage history, or Monitoring dashboard changes. No caller-supplied thread identifier or inspection of another session. Preserve conversation and observation privacy; return numeric status only, never observation text or message contents.

New Mastra IDs use `snake_case`, starting with `conversation_context`. Existing agent/tool IDs remain unchanged; their refactor is deferred.

## Verified starting points

- `src/mastra/agents/jamis.ts`: Jamis owns direct tools, thread-scoped Observational Memory, and specialist processors. Recent historical token-use questions currently route to `checkMonitoring`.
- `src/mastra/tools/current-time.ts`: existing small direct-tool pattern.
- Installed `@mastra/core` 1.71.0: `processOutputStep` receives per-step usage and runs before local tool execution. Request context is available to both processors and tools.
- Installed `@mastra/memory` 1.32.1: native `data-om-status` reports active message/observation tokens and thresholds. `Memory.omEngine` exposes `getStatus`, but its implementation calls `getOrCreateRecord` despite the read-only documentation. Do not blindly call it on an uninitialized session.
- `src/mastra/gateways/openai-codex-gateway.ts`: preserves provider usage but does not declare context capacity. No capacity number is verified yet.
- `src/mastra/observability.ts`: protected exports retain numeric usage but strip conversation/runtime context.

## Stages

### 1. Capture request-local numeric context measurements

**Goal:** prove the installed framework can supply both measurements safely before adding the chat interface.

**Critical files:** new `src/mastra/processors/conversation-context.ts` and focused tests; `src/mastra/agents/jamis.ts` only as needed to attach the processor. Inspect installed processor/chunk plumbing before choosing the OM hook. Prefer native OM status over a second storage query; if native status is not available on both stream and generate paths, use the active message list with an existing OM record and verified read-only status path. Do not introduce a global last-value cache or create a record just to report status.

Capture current-step provider input usage and actual model identity before tool execution. Keep numeric OM status scoped to the same request/session. Reuse the existing request-local processor pattern; ensure specialist invocations cannot overwrite Jamis's measurement. Verify model capacity against authoritative gateway/model metadata if available; leave it unavailable otherwise rather than hardcoding an unsupported number.

**Verification:** tests exercise stream and generate paths, multiple model steps, missing versus zero usage, disabled/unavailable OM, concurrent request isolation, and numeric-only capture. Include a deterministic mock-provider proof that the measurement is available before a local tool executes. Run the repository gate.

**Demoable acceptance:** a mock Jamis run with known provider input tokens and OM status exposes the expected request-local numeric snapshot before tool execution, with no observation/message contents and no added memory writes.

**Proposed commit:** `feat: capture request-local Jamis context measurements`.

### 2. Expose context usage through a direct chat tool (TDD)

**Goal:** answer ordinary context-usage questions using Stage 1 measurements, not model guesses or historical Monitoring. Stage 2 is implemented and reviewed. Operator approved commit, push and deployment with the remaining repository gate failures left unchanged; both authorized live routing smokes have now passed. The combined regression and full-gate ACs remain open as recorded above. The steps below are red/green cycles inside one independently committable stage, not separate commits containing intentionally failing tests.

**Critical files:** new `src/mastra/tools/conversation-context.ts` and `src/mastra/tools/__tests__/conversation-context.test.ts`; `src/mastra/agents/jamis.ts`; `src/mastra/agents/__tests__/provider-tool-schema.test.ts` for actual-registration/SDK proofs; `src/mastra/agents/__tests__/project-understanding.test.ts` only to include the newly registered tool in its existing exact tool-list assertion; existing capture tests as regression checks; `docs/CONTEXT.md` only if a concise terminology distinction is needed. Reuse the existing isolated agent fixture; do not refactor other suites or add test infrastructure.

**Contract:** one no-argument, read-only direct tool, with new Mastra ID `conversation_context`. It reads the current request's captured snapshot, returns separate model-context and OM results with explicit availability and measurement timing, and exposes no message/observation contents or caller-selected session. Model identity accompanies available usage. Capacity and derived percentage/headroom remain explicitly unavailable because the actual gateway declares no verified capacity. Explain that the measurement precedes the final answer, OM thresholds trigger compaction, and input headroom would not guarantee remaining output. Current-context questions route to this tool; historical token-use requests stay on Monitoring. No specialist delegation, new storage reads/writes, persisted history, warnings, dependencies, or services.

#### 2.1. Establish the baseline and write the first RED tests

1. Run the existing Stage 1 capture/provider-schema/delegation tests before changing implementation. Record the full repository gate separately so known failures cannot be mistaken for the new feature's RED state.
2. Derive a small output contract and literal expected results from JAM-76's ACs. First write representative registration and normal-result integration tests against the actual default `createJamisAgent` tool registration, on both generate and stream paths. Do not inject a replacement context tool through `config.tools`, stub the snapshot reader, or compute expected values with the implementation under test.
3. Use known provider/OM fixture values, for example current-step input `222`, messages `123/30000`, and observations `456/40000`. Expected results must assert these independent literals, model identity, separate measurements, unknown capacity, and timing metadata. Inspect the actual tool result, not just the scripted model's final text.
4. Run the tests and record command, exit status, test names and the expected failure. Start from existing agent registration so absence of the new tool produces an assertion failure, not a missing-module/import error. A broken fixture, failed network call, or unrelated baseline failure does not count as RED. Fix test setup only until the tests reach the intended feature assertion.

**Mandatory Operator checkpoint:** show the proposed output contract, test diff, remaining case checklist and observed RED evidence. Stop for approval before writing tool implementation or registration. Do not commit a knowingly red intermediate state. This checkpoint approval is not commit/push/deploy approval.

#### 2.2. GREEN, then repeat one behavior at a time

After red-test approval, implement only enough tool/registration behavior to pass the first tests. Reuse `readConversationContext` and the Stage 1 processor; no new cache or snapshot setter for tests. Then add each missing contract case, observe its meaningful failure, make the minimum change, and rerun all Stage 2 tests:

- **Partial availability:** missing provider usage with available OM; available model usage with disabled/unavailable OM; neither measurement; absent or finalized request context. One unavailable result must not hide the other.
- **Zero and unknowns:** zero input/OM counts are available zero, not missing; unavailable counts/capacity/derived values are explicit and never fabricated. No numerical output-capacity guarantee.
- **Latest-step identity:** multiple local tool steps use the latest completed Jamis call, not summed input/output or specialist usage. Use different literal counts across calls; keep both generate/stream proofs.
- **Privacy and scope:** schema has an object root and no arguments, and rejects caller-supplied thread/session selectors. Request/session isolation remains intact; sentinel message/observation contents never appear in tool output. Tool execution adds no storage reads/writes. Keep existing collector tests rather than duplicating its complete suite.
- **Routing and compatibility:** assert new tool registration/SDK schema and the instruction distinction between current context and historical Monitoring. Preserve the existing Monitoring/delegation/session behavior; scripted-provider tests prove plumbing, not a real model's choice of tool.

Keep approved expected results fixed while implementing. Do not delete/skip failing cases, loosen assertions, copy implementation logic into expected values, or alter the contract merely to obtain green. If a test expectation is genuinely wrong, explain the conflict with the ticket and obtain approval before changing it. Refactor only if it simplifies the green implementation without expanding scope. No mutation-testing dependency or multi-agent pipeline is needed.

**Focused red/green command:** `bun test src/mastra/tools/__tests__/conversation-context.test.ts src/mastra/agents/__tests__/provider-tool-schema.test.ts`. Run existing capture/delegation regression tests after each meaningful change. New schema/execution behavior must have its own observed RED evidence; already-green checks are retained regressions, not claimed as new TDD cycles. Do not break already-correct behavior merely to manufacture RED.

#### 2.3. Verify, review and obtain commit approval

- Confirm all new/affected tests pass and temporarily remove the new registration to prove the actual-tool integration assertion fails; restore it immediately and rerun green. This guards against a test that never exercises the registered tool.
- Run the repository gate and report scoped results, skips and unchanged baseline failures separately. Investigate any new regression introduced by Stage 2. Do not repair unrelated baseline tests/lint/typecheck or relax global checks to make this PR green; obtain explicit acknowledgement of remaining baseline failures at sign-off.
- Review the contract tests and implementation together for ticket correctness, privacy and scope. Record RED/GREEN evidence and the diff summary, then wait for explicit commit approval. Push/deployment remain separate approvals.

**Demoable acceptance:** a deterministic question invokes the actual registered tool and returns current model input tokens and OM token/threshold pairs separately, with explicit unknown capacity and pre-answer timing. After authorized deployment, a real Operator DM asks “How much context are we using?”; confirm actual tool execution in the trace, compare reported model input with the preceding provider call, and check the response for both measurements, availability and terminology. Protected traces omit tool outputs; use an authorized request result if available, otherwise explicitly report the live OM verification limit. Do not add diagnostic logging/persistence to expose the snapshot. Mock success is not live acceptance. Do not assert exact natural-language wording from a scripted provider.

**Proposed commit:** `feat: let Jamis report conversation context usage`.

**Research behind this approach:**

- [Simon Willison, Red/green TDD](https://simonwillison.net/guides/agentic-engineering-patterns/red-green-tdd/): write tests first, observe failure, then implement; a test that already passes may not exercise the new behavior.
- [Anthropic, Claude Code best practices](https://code.claude.com/docs/en/best-practices#give-claude-a-way-to-verify-its-work): give the coding agent runnable verification and require evidence; fresh-context review can check correctness and scope without accepting the writer's confidence as proof.
- [Augment Code, Spec + TDD](https://www.augmentcode.com/guides/spec-tdd-shippable-ai-generated-code): practitioner guidance warns about tests mirroring generated implementation or being weakened to pass. Use ticket-derived expectations and minimum red/green steps, not its larger commercial workflow.

## Stage 2 initial RED checkpoint

- Test-only changes in `src/mastra/agents/__tests__/provider-tool-schema.test.ts`: both generate/stream cases resolve Jamis's actual default tool registration, then assert the actual tool-result payload. The existing Responses SDK schema proof now requires the new strict empty-object schema. No reporting tool, registration or routing implementation has been added.
- Proposed normal-result contract: `measurementPoint: latest_completed_jamis_model_call_before_tool_execution`; `modelContext` has `status: available`, provider/model ID, step `0`, input `222`, and null capacity/usage percentage/input headroom; `observationalMemory` has `status: available`, messages `123/30000`, observations `456/40000`, `thresholdMeaning: compaction`, and `countsMayBeEstimated: true`. Expected values are independent literals. Final model usage is deliberately different (`333`). Privacy sentinels and post-run cleanup are also asserted.
- Initial RED command: `bun test src/mastra/processors src/mastra/agents/__tests__/provider-tool-schema.test.ts src/mastra/agents/__tests__/jamis-delegation.test.ts`. Result: 9 parent tests pass, 1 parent fails. Its isolated child has 2 existing capture tests pass and 3 intended failures: generate/stream registration is missing, and the actual Responses SDK request lacks the context schema. No import/transport error is counted as RED. Output assertions after the registration guard have not yet executed.
- Before edits: focused baseline 10 passed; full suite 421 passed / 14 skipped / 51 failed; typecheck 20 existing errors; lint 584 existing findings (322 errors, 262 warnings); build and 4 infra tests passed. After RED edits, typecheck output is identical to baseline and the edited file retains only its existing lint findings. Diff whitespace check passes. Unrelated baseline repairs remain excluded.
- Independent read-only Mastra subagent verified pinned APIs and current primary docs: [listTools](https://mastra.ai/reference/agents/listTools), [Processor interface](https://mastra.ai/reference/processors/processor-interface), [createTool](https://mastra.ai/reference/tools/create-tool). Confirmed per-call processor preservation and tool-result access; strict runtime input validation and output validation are required. Synthetic OM emission proves interception, not native OM initialization or natural-language tool selection; existing Stage 1 native tests remain the regression proof.
- Remaining cases after approval: partial/unavailable results, zero versus missing, absent/finalized requests, latest-step and specialist isolation in tool output, runtime selector rejection, routing/Monitoring compatibility, registration-removal check, repository gate and authorized live acceptance. Keep the approved expectations fixed; explain and obtain approval for any contract correction.
- Operator approved GREEN after `/review-code` and `/ponytail-review` in separate GPT-6-Astra medium subagents reported no findings. Initial RED evidence is historical; the original payload expectations were not weakened. Nothing committed, pushed or deployed for Stage 2; no live provider/channel call.

## Stage 2 implementation and verification

- Added the no-argument, read-only `conversation_context` tool with strict runtime input validation and an output schema. It reads only Stage 1's current-request snapshot. Model/OM availability is independent; zero stays zero; capacity, usage percentage and input headroom remain explicitly null. It introduces no storage access, cache, persistence or dependency.
- Registered the direct tool on Jamis and separated current-context routing from historical token-use Monitoring. Added its key to the existing exact project-tool inventory test. Operator explicitly chose to retain formatting-only changes applied to existing test files; those files were staged externally during verification. The approved formatting was subsequently included in the Stage 2 commit.
- Initial observed RED became GREEN without changing the approved normal-result expectations. Temporarily removing registration reproduced missing-tool/schema failures; restoring it returned the suite to GREEN. Additional edge cases already passed with the minimum implementation and are retained regression checks, not manufactured RED cycles.
- Final focused suite: 20 parent tests passed across tool, collector, provider-schema, delegation and project-understanding files. The isolated provider fixture also passes its seven child tests, including both generate/stream actual-tool result checks and repeated-step reporting. Coverage includes partial/unavailable results, zero, invalid counts, absent/finalized requests, latest versus aggregate usage, request isolation, privacy sentinels, runtime selector rejection and no storage access. Scripted models prove plumbing and instruction presence, not live routing.
- Full gate is **not green**. One completed run reported 429 passed / 14 skipped / 51 failed, with exactly the same 51 failure names as the pre-change baseline (421 / 14 / 51). Later runs reported 428 / 14 / 52: an unchanged Docker-stub startup assertion timed out on one run, and the unchanged isolated Research HTTP fixture timed out on another. Both affected suites passed separately (6 Docker-stub tests; 1 Research wrapper). No cause for the intermittent timeouts is asserted, and no unrelated fixture was repaired or timeout relaxed.
- Final typecheck output is identical to baseline: 20 existing errors, none introduced. Repository lint: 579 findings (318 errors, 261 warnings), versus baseline 584 (322, 262), after the approved formatting. Both new tool files lint cleanly with the project's Bun-based ESLint invocation. Build, four infra unit tests and staged/full-diff whitespace checks pass.
- Final read-only `/review-code` and `/ponytail-review` passes in separate GPT-6-Astra medium subagents found no introduced issues. The correctness reviewer reran 18 focused checks and verified actual tool/SDK results, native OM capture and delegation; full-gate comparison was performed by the parent.
- At the pre-commit checkpoint, Stage 2 had not been committed, pushed, deployed or live-smoked. Verified model capacity and live numerical OM/tool-routing acceptance remain unavailable. Full-gate AC remains unchecked. Operator subsequently approved commit (`feat: let Jamis report conversation context usage`), push and deployment with the gate failures left unchanged. Guide real DM acceptance one step at a time after deployment.

## Live smoke follow-up: model identity and trace identity

- Stage 2 was committed, pushed and deployed as `6a41cbb`. The first Operator DM reported model input `27735`, OM messages `14190/30000` and observations `0/40000`, with unknown capacity and the expected timing/compaction caveats. Trace `2b7ea53e973cd74cc92c252362ee528b` had no error spans; model calls used `27735` then `27896` input tokens, confirming the reported pre-answer input count. Protected traces do not independently establish the OM counters.
- Confirmed two gaps: the reply omitted model identity, and the new fixed tool registry key was absent from the trace entity allowlist. Operator requested both fixes and code reviews before any further commit/deployment.
- Added tests first: instruction assertions for captured provider/model ID and unknown handling; a native Jamis tool span/log/metric test for retained `conversation_context` identity and removal of private sentinel content. Both targeted tests failed before the fixes, then passed. Added an explicit instruction to report the tool's provider/modelId without guessing and one exact-key allowlist entry. Inputs, outputs, runtime context and private metadata remain excluded; no new persistence or logging payload.
- Follow-up focused suite: 23 passed. Full suite: 429 passed / 14 skipped / the same 51 baseline failures by name. Typecheck retains exactly the same 20 baseline errors. Build, four infra tests and whitespace checks pass. `/review-code` and `/ponytail-review` in fresh GPT-6-Astra medium subagents found no introduced issues. Scripted checks verify the instruction contract, not live model obedience.
- Operator approved commit, push and deployment of the reviewed follow-up as `c7efbd9`. The repeated context DM and historical Monitoring regression smoke both passed; see the current checkpoint for trace evidence and the remaining ACs. Model capacity and independently measured live OM values remain unverified.

## Stage 1 implementation and verification

- Added `src/mastra/processors/conversation-context.ts`, attached to Jamis's input/output pipelines. It captures numeric native OM status and resolved model identity in per-request processor state, then publishes current-step provider input usage before local tool execution. Request-context snapshots reset before each provider call and are removed at normal finalization. No storage queries or writes are added.
- Native OM status reaches output processors in both `generate()` and `stream()` on the pinned packages. No `getStatus()` fallback is needed. Tests compare native status/record reads and ordinary persistence calls with capture enabled versus disabled.
- Added eight focused tests in `src/mastra/processors/__tests__/conversation-context.test.ts` and two production-Jamis execution proofs inside the existing isolated provider-schema fixture. Coverage includes latest-step usage, missing versus zero, native OM, invalid/cross-session status, request concurrency, nested invocation isolation, numeric-only capture, and cleanup.
- Public API/location cross-check: [Processors](https://mastra.ai/docs/agents/processors), [Processor interface](https://mastra.ai/reference/processors/processor-interface), and [Observational Memory](https://mastra.ai/docs/memory/observational-memory). Public examples use `src/mastra/processors/`; current-step usage precedes local tool execution; custom data chunks require `processDataParts: true`. Pinned runtime source and integration tests confirm native OM delivery.
- Focused capture/provider-schema/delegation run: 10 parent-process tests passed; the provider-schema subprocess also exercises both new production-Jamis proofs. New processor files lint cleanly.
- Full suite: 421 passed, 14 skipped, 51 failed. Detached committed baseline `8cb2f9a` with the same dependencies/environment: 413 passed, 14 skipped, the same 51 named failures. No current-only failures.
- Typecheck: the same 20 errors at committed baseline and with Stage 1, all in existing `sendblue-broadcast.test.ts`. No new typecheck errors.
- Repository lint baseline: 322 errors and 262 warnings in existing files. Do not repair unrelated files as part of this stage.
- Build, four infrastructure unit tests, and diff whitespace checks passed. Database-dependent cases remain skipped without a disposable test database. No live provider, channel send, deployment, commit, or push was performed for Stage 1.

- Pre-commit review: three independent, read-only GPT-6-Astra high-effort subagents ran `/review-code`, `/security-audit`, and `/ponytail-review`. All reported no introduced findings. The correctness reviewer additionally ran six inline checks for model switching, retries, and stale-usage clearing after provider failure across generate/stream. Resume and abort behavior was source-traced, not execution-tested; live provider/channel behavior and dependency advisories remain unchecked. Parent reran the focused suite (10 passed) and both staged/unstaged whitespace checks after all reviews. Operator subsequently approved committing and pushing Stage 1 with the known baseline failures left unchanged.

The collector's `processOutputStep` requires model completion before local tools execute so provider usage is available. This can defer tool execution that would otherwise start eagerly. Model capacity remains unavailable; the gateway declares no verified limit.

## Repository gate and sign-off

For each stage: focused tests, `bun run typecheck`, `bun test`, `bun run lint`, `bun run build`, `python3 -m unittest discover -s infra -p 'test_*.py'`, and `git diff --check`. Report skipped database-dependent or credential-dependent checks explicitly.

Implement and verify one stage at a time. Show diff summary and proposed commit message, then wait for explicit commit approval before committing or moving to the next stage. Push, deployment, and Linear issue updates require separate confirmation. Re-run the full gate after the final stage.
