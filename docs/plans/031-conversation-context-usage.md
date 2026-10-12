# JAM-76: On-demand conversation context usage

Status: Proposed. No implementation or commit approval yet.

Tracking: [JAM-76](https://linear.app/abdirahman-haji/issue/JAM-76/ask-what-the-current-conversations-context-window-is-at).

## Agreed scope

The operator can ask Jamis in ordinary chat how much context the current conversation uses. Report two clearly separated measurements:

1. **Model context:** provider-reported input tokens for the latest completed Jamis model call in this request. Identify the model and measurement point. Never use cumulative run usage, historical Monitoring totals, or specialist usage as current context occupancy.
2. **Observational Memory:** current active message and observation token counts against their observation/reflection thresholds. Explain that these thresholds trigger memory compression, not model context exhaustion.

Report model capacity, percentage, and input headroom only when capacity is verified for the actual gateway/model. Otherwise explicitly report capacity and percentage as unavailable. Input headroom is not a guarantee about remaining output: reasoning/output and subsequent tool results also consume capacity.

The measurement precedes the answer: the call that requests the tool has completed, while the final answer has not. Missing provider usage is unavailable, not zero. OM counts use Mastra's own counting and may be estimates. Unavailable OM or usage must not suppress the other successful measurement.

No automatic warnings, compaction changes, context trimming, new dependencies, new services, persisted usage history, or Monitoring dashboard changes. No caller-supplied thread identifier or inspection of another session. Preserve conversation and observation privacy; return numeric status only, never observation text or message contents.

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

## Repository gate and sign-off

For each stage: focused tests, `bun run typecheck`, `bun test`, `bun run lint`, `bun run build`, `python3 -m unittest discover -s infra -p 'test_*.py'`, and `git diff --check`. Report skipped database-dependent or credential-dependent checks explicitly.

Implement and verify one stage at a time. Show diff summary and proposed commit message, then wait for explicit commit approval before committing or moving to the next stage. Push, deployment, and Linear issue updates require separate confirmation. Re-run the full gate after the final stage.
