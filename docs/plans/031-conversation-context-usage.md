# JAM-76: On-demand conversation context usage

Status: Stage 1 implemented and reviewed; Operator approved commit and push with known baseline failures left unchanged. Focused checks pass; repository-wide gate remains blocked by reproduced baseline failures. Stage 2 has not started.

Tracking: [JAM-76](https://linear.app/abdirahman-haji/issue/JAM-76/ask-what-the-current-conversations-context-window-is-at).

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

### 2. Expose context usage through a direct chat tool

**Goal:** answer ordinary context-usage questions using those measurements, not model guesses or historical Monitoring.

**Critical files:** new `src/mastra/tools/conversation-context.ts` and focused tests; `src/mastra/agents/jamis.ts`; relevant agent/provider-schema tests; `docs/CONTEXT.md` only for a concise terminology distinction.

Register one no-argument read-only tool on Jamis. Return separately labeled model-context and OM results, measurement timing, numeric values, and explicit availability. Include verified capacity-derived values only when available. Instructions route current-conversation context questions to this tool while retaining historical token-use requests on Monitoring. No specialist delegation is needed.

**Verification:** tool-schema and output tests cover both successful measurements, partial/unavailable results, no active request context, and zero usage. A deterministic agent integration test calls the actual registered tool and verifies it receives the current request's snapshot. Preserve existing Monitoring/delegation/session regressions. Run the repository gate.

**Demoable acceptance:** ask “How much context are we using?” in a deterministic test conversation and inspect the tool result: current model input tokens and OM token/threshold pairs are separate; unknown capacity is explicit. A real operator DM smoke is a separate acceptance check, subject to credential/deployment availability.

**Proposed commit:** `feat: let Jamis report conversation context usage`.

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
