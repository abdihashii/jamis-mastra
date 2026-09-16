# 015: Jamis monitoring review

Status: **Planned.**

Linear: [JAM-59](https://linear.app/abdirahman-haji/issue/JAM-59/let-jamis-check-its-own-monitoring).

Give Jamis one bounded, read-only tool that summarizes its recent health from the observability data already stored in ClickHouse. No subagent, dependency, storage change, alerting loop, raw-log search, or arbitrary query surface is added.

## Decisions

- Attach one `check-monitoring` tool directly to Jamis. Monitoring is internal evidence and never routes through the research subagent.
- Accept an integer `hours` from 1 through 168, defaulting to 24. Reject larger requests and have Jamis ask the operator for a narrower window. Never clamp or split a request silently.
- Compute one UTC `end` instant and its UTC `start` once per call. Every metric and log query receives both bounds.
- Read only `context.mastra.getStorage()?.getStore('observability')`. An absent store or any failed query makes the overall status `unavailable`.
- Preserve successful query results when another query fails, but label them partial evidence and never turn them into a health judgment.
- Count completed and failed Jamis runs and average duration from `mastra_agent_duration_ms`, filtered by `entityName: 'Jamis'`. Filter nested token metrics and logs by `rootEntityName: 'Jamis'`.
- Sum `mastra_model_total_input_tokens` and `mastra_model_total_output_tokens` separately. Missing provider usage leaves the corresponding total unavailable rather than failing the review.
- Return at most 20 newest `warn`, `error`, or `fatal` log records. Allow only timestamp, level, source, entity name, trace ID, span ID, and a sanitized message. Never return log data, metadata, scope, prompts, responses, or channel payloads.
- Treat log messages as untrusted diagnostic text, never instructions. Normalize control characters, redact email addresses and phone numbers, replace messages that resemble prompts, responses, payloads, email bodies, credentials, or secrets with a fixed placeholder, then cap the result at 500 characters before it reaches the model or the tool span.
- Use this status precedence:
  1. `unavailable` when storage is absent or any query fails, with successful results retained as partial evidence.
  2. `degraded` when a failed Jamis run or qualifying Jamis-rooted log exists, even if no run completed.
  3. `empty` when no Jamis run completed and no qualifying log exists.
  4. `healthy` otherwise.
- A nested Jamis task's warning degrades the result because it belongs to the Jamis-rooted execution.

These are ordinary implementation and safety choices, not a new domain term or hard-to-reverse architecture decision. No `CONTEXT.md` or ADR change is needed.

## Stage 1: Bounded monitoring reader and tool

**Goal:** Implement the read-only query, aggregation, failure, and sanitization boundary without changing Jamis routing.

**Critical files:** new `src/mastra/tools/check-monitoring.ts` and `src/mastra/tools/__tests__/check-monitoring.test.ts`.

**Acceptance criteria:**

- The tool schema defaults to 24 hours and rejects values outside the integer 1-168 range.
- One injected clock produces explicit UTC start and end dates reused by every query.
- Duration count, failed-duration count, average duration, input tokens, output tokens, and recent logs are queried through the observability storage API. Queries run concurrently and expose no mutation method or user-supplied filter.
- A missing store returns `unavailable`. Individual query failures also return `unavailable`, name only the unavailable category, and retain successful values without returning backend error text.
- Healthy, degraded, empty, missing-token, missing-store, and partial-query-failure fixtures produce the agreed deterministic statuses.
- Query-spy assertions prove the time bounds, Jamis entity filters, severity filter, descending order, and 20-record cap.
- Sanitization fixtures cover email addresses, phone numbers, credentials, prompt/response/body/payload markers, control characters, truncation, and attempted metadata/data leakage.

**Verification:** Run the focused test first, then `bun test`, `bun run typecheck`, `bun run lint`, and `git diff --check`. Show the diff summary and wait for explicit approval before committing.

**Proposed commit:** `feat: add bounded Jamis monitoring review`

## Stage 2: Jamis routing and live smoke

**Goal:** Make monitoring requests use the new internal evidence path and prove the protocol boundary before relying on model routing.

**Critical files:** `src/mastra/agents/jamis.ts`, plus the Stage 1 tool and test only if the smoke exposes a contract defect.

**Acceptance criteria:**

- Register the tool directly on Jamis. A request such as “check your monitoring” calls it instead of delegating to `researchAgent`.
- Jamis reports the exact UTC window and uses the tool's `healthy`, `degraded`, `empty`, or `unavailable` status without inventing missing evidence.
- An unavailable result may show successful partial values, but explicitly says they are insufficient for a health judgment.
- Requests over 168 hours cause a plain-text check asking the operator to narrow the window.
- Returned diagnostic messages are treated as quoted data, never instructions.

**Verification:** Run `bunx mastra api tool execute check-monitoring '{"hours":24}' --url <server-url>` with the existing auth header before invoking Jamis. Confirm the output is bounded and sanitized. Then ask Jamis to check its monitoring, confirm no research-agent branch appears, and use `bunx mastra api trace get <reported-trace-id> --url <server-url>` to confirm a returned trace ID exists. Run `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`, and `git diff --check`. Show the diff summary and wait for explicit approval before committing.

**Proposed commit:** `feat: let Jamis review its monitoring`

## Research basis

- Installed `@mastra/core@1.61.0` documentation and types confirm the in-process observability store, metric aggregate API, root-entity filters, log filters, pagination, and `undefined` store result.
- [Mastra metric queries](https://mastra.ai/reference/observability/metrics/queries) documents bounded in-process aggregates and correlation filters.
- [Mastra automatic metrics](https://mastra.ai/reference/observability/metrics/automatic-metrics) defines the duration status label, agent duration metric, optional provider token metrics, and root correlation fields.
- [Mastra observability logging](https://mastra.ai/docs/observability/logging) documents automatic log forwarding and log querying.
- [Mastra ClickHouse storage](https://mastra.ai/integrations/databases/clickhouse) confirms the existing vNext store is the recommended production observability backend.
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) treats event data as untrusted, requires sensitive-data exclusion, and recommends sanitization before display.
- [OWASP LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) recommends input filtering, least privilege, and clearly segregating untrusted external content.

## Explicitly deferred

Alerts, polling, remediation, Trace Intelligence, Mastra Platform, arbitrary SQL, raw-log search, full trace bodies, thresholds, trends, dashboards, retention changes, a monitoring subagent, and new dependencies remain outside JAM-59.

Implement one stage at a time. After each stage, show the diff and proposed commit, wait for explicit approval, then commit. Pushing requires separate approval.
