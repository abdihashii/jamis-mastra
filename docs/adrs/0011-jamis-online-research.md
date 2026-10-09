# Jamis online research through a Firecrawl-powered research subagent

Jamis will gain online research as a first-class capability by delegating to one internal research subagent that owns Firecrawl search and single-page scrape tools. The subagent discovers relevant public webpages and reads selected pages; Jamis remains the only public agent and owns the final answer. Evidence requirements constrain how Jamis uses this capability for factual answers.

## Architecture amendment: permitted domain callers (2026-10-08 UTC)

Status: accepted design, not implemented. The Operator selected direct domain-to-Research delegation during the [architecture walkthroughs](../jamis-agent-architecture.md). This revises the target architecture's Jamis-only caller restriction; the existing code remains Jamis-only until a separately planned implementation.

- Jamis and explicitly configured domain specialists may call Research for a bounded contribution within their assigned task. Research returns evidence to its caller; the caller retains ownership of its assignment. Research itself uses only its permitted tools/workflows and does not delegate to agents.
- Apply the same Research privacy, evidence, refusal, price, and task-budget policy at every permitted caller boundary. Caller-added instructions, another invocation, or delegation through another agent cannot expand authority or reset the same research task's budget. Native per-agent configuration exposes only explicitly permitted callees.
- Pass only the current public research question and necessary public context. A generic query may use public labels extracted from account data, such as airline and public fare-class names; private messages, identity, booking references, itineraries, unrelated history, credentials, and broader caller runtime capabilities stay out. Message filtering alone does not constrain Mastra's separately copied request context.
- Work remains sequential. Jamis handles every Operator question, approval, and final response in its own voice. Domain-to-domain calls and further capability-agent delegation remain outside the selected initial scope.

Provider ownership, source standards, existing action gates, and unavailable writes are unchanged. Typed handback, nested control propagation, and public-only context isolation require verification together before implementation is accepted. Historical Jamis-only statements below describe the original rollout and current implementation, not the amended target caller set.

The [native invocation boundary](../jamis-agent-architecture.md#native-mastra-invocation-boundary) specifies the engineering default for typed results and one authoritative Research entry path across permitted callers. It also constrains explicit query construction for private-to-public projections; filtering messages or copying a typed context alone does not establish public-only input. This is design documentation, not an implemented delegation or privacy guarantee.

## Amendment: neutral tool boundary (JAM-63, 2026-09-27 UTC)

The original decision below records the Firecrawl-only rollout. Research now exposes only `web-search` and `web-scrape`, with provider-neutral schemas, instructions, and execution errors. Provider selection, credentials, upstream payloads, normalization, and safe operation telemetry belong to one web-tool module; they are absent from the agent-facing interface. Firecrawl remains the sole scraper, including PR #35's Firecrawl 4.41.0 freshness settings and disabled processing-timeout resumption.

Research ownership, delegation, source quality, citation/refusal behavior, instruction-based budgets, and existing private tool-result retention remain unchanged. Historical incident-component mappings remain available alongside the neutral tool names. Search defaults to Perplexity's native Search API (direct `fetch`, three results, medium context, fixed 30-second timeout). `WEB_SEARCH_PROVIDER=firecrawl` manually selects Firecrawl search. Invalid selections and missing selected credentials fail at startup: Perplexity search requires `PERPLEXITY_API_KEY`, and page reading always requires `FIRECRAWL_API_KEY`. Firecrawl-only operation needs no Perplexity key. No application retry or provider fallback is added; candidates expose only titles and URLs and must be scraped before serving as evidence.

## Amendment: specialized research evidence (JAM-74, 2026-10-01 UTC)

Stage 1 implements the independent structured-source boundary: two domain tools discover bounded paper/Developer contracts and retrieve normalized evidence. Provider selection, contract validation, the conservative six-credit Developer bound, provenance, and safe failures remain inside `research-sources.ts`. Contracts and pre-generated request identities live only in the owning task's Mastra request context; shallow-copied delegation state cannot authorize another task. Stage 1 committed as `7e84cca` and Stage 2 as `6c3848b`, both after operator sign-off. The feature branch was pushed and deployed with explicit approval. Representative agent checks, the source-failure/incident-triage regression, and both production iMessage traces passed; PR review/merge remains pending. See [Plan 025](../plans/025-alexandria-research-sources.md).

Only the research subagent receives the tools and automatically selects Developer sources for code and API questions, paper sources for paper-based questions, and ordinary webpage research for other tasks. Jamis retains delegation and the final answer. Specialized sources remain read-only and do not become another `WEB_SEARCH_PROVIDER` value. Native concurrency is one, with five steps and instruction-based task budgets. The delegation hook removes parent-added instructions and pins five steps so the research policy survives delegation. Jamis must not redelegate the same research task to bypass its budget.

Retrieved abstracts may support claims explicitly stated in them when labeled abstract-only; they do not establish that full text was read. Discovery descriptions and unread metadata remain candidates, not evidence. Cited webpages still require scraping; structured findings require retrieved content with original source provenance.

Terms-required failures may return only an insufficient-evidence reply with the exact validated admin action URL, treated as access metadata rather than a cited source. No terms are accepted. All other inadequate-evidence paths retain the exact refusal; API usage instructions also require adjacent sentence-level citations.

Hard source failures record fixed safe span errors while retaining neutral tool outputs, so existing incident triage can find failed reads. Normal evidence gaps and terms-required access handoffs do not become application errors.

The operator permits automatic Developer Index execution with a verified upper bound of six credits per call. Unknown pricing or a higher bound blocks execution. Live billing units must be checked before execution; reported usage must not be inferred from a discovery price. Representative live and production smokes verified the SDK answer within this cap: three index records and at most two additional page reads, with two index credits reported. Page-reading costs remain unknown in the existing neutral tool output; this is not a general coverage guarantee.

Research Index search may retrieve up to ten paper candidates so the subagent can select stronger evidence. Each record-fetching provider call, including index search, counts toward the task's three retrieval-call limit across webpages and structured sources; at most three sources may be cited. A paper search therefore leaves at most two further reads.


Production acceptance on 2026-10-01 UTC verified one delegation/discovery per question, sequential reads within the combined three-call limit, adjacent citations grounded in actual content, and public-task-only subagent input. The abstract-only case used one retrieval and zero credits; the SDK case used three retrievals and two reported index credits. Existing model response-header retention is a separate telemetry concern tracked in [JAM-78](https://linear.app/abdirahman-haji/issue/JAM-78/restrict-model-response-headers-retained-in-traces); no raw trace/header values enter this ADR.

## Context

Jamis currently answers ordinary conversation directly and delegates current weather to `weather-agent`. It cannot discover public webpages from a question or read selected pages, so it cannot fulfill a general online-research request. It also has no general live source for current product behavior, people and organization status, dates, numbers, quotations, or recommendations that depend on changeable facts. An instruction based on whether Jamis feels uncertain is not sufficient because some models express confidence even when their answer is unsupported.

Mastra's [Firecrawl integration](https://mastra.ai/integrations/tools/firecrawl) is a recipe for installing the official `firecrawl` SDK and wrapping its search and scrape APIs with Mastra `createTool`. It is not a built-in tool that replaces Firecrawl with another backend.

Mastra's [built-in tools](https://mastra.ai/docs/agents/tools#built-in-tools) solve different problems:

- `webFetchTool` reads a known HTTP or HTTPS URL directly. It does not discover sources and does not use Firecrawl.
- `webSearchTool` invokes provider-native search and supports OpenAI, Anthropic, Google Gemini, and xAI. It does not use Firecrawl, so it remains excluded even though Jamis now uses an OpenAI model.

Mastra [subagents](https://mastra.ai/docs/subagents) are explicitly attached to a parent agent through its `agents` property. They are not inherited by sibling agents. The parent chooses when to delegate, receives the subagent's text result, and synthesizes the user-facing response.

The broader guidance agrees with keeping one agent in control:

- [OpenAI's orchestration guide](https://openai.github.io/openai-agents-python/multi_agent/) recommends agents-as-tools when a manager should retain the conversation and final answer.
- [LangChain's architecture guide](https://www.langchain.com/blog/choosing-the-right-multi-agent-architecture) recommends centralized subagents for isolated specialist work, with an acknowledged extra model call.
- [Anthropic's research-system report](https://www.anthropic.com/engineering/multi-agent-research-system) finds multi-agent research effective for broad parallel work but substantially more expensive, and notes that coding work is usually less parallelizable.

## Decision

- Give Jamis online research by adding an internal `researchAgent` to its `agents` property. Jamis delegates explicit online-research requests and verification-required claims; the subagent discovers sources, reads selected pages, and returns an evidence memo. Do not register it on the root Mastra instance.
- Give Firecrawl tools only to `researchAgent`. Use the official `firecrawl` SDK with one search tool and one single-page scrape tool. Do not attach `webFetchTool` or `webSearchTool` as a fallback.
- Let only Jamis delegate to `researchAgent`. A future coder or other sibling subagent receives research through Jamis. Direct nested access requires an explicit later decision based on traces showing that supervisor sequencing is inadequate.
- Pin Mastra's direct runtime dependencies to the production-tested set: `@mastra/core@1.61.0`, `@mastra/clickhouse@1.15.2`, `@mastra/memory@1.27.0`, `@mastra/observability@1.17.1`, and `@mastra/pg@1.21.1`. Pin `mastra@1.25.0` too, so Mastra's isolated build writes the same direct runtime set as the root install.
- Use Mastra's `delegation.messageFilter` on Jamis to pass no prior parent messages to `researchAgent`, while preserving messages for other subagents. Keep it a pure synchronous branch with no operations expected to throw. The original 1.59.0 analysis found filter errors resumed with unfiltered history and no native fail-closed setting. Production now runs 1.61.0; its filter-error path remains an unproven residual risk. The filter also does not remove Mastra `RequestContext`, which is copied separately to the child. Jamis must put only the current research task and necessary public context in the delegation prompt, and the Firecrawl tools must not consume `RequestContext`. Treat scraped page content as untrusted data, never as instructions, and never send private context or secrets in a Firecrawl query or URL.
- Use `openai/gpt-5.6-terra` with `openai.reasoningEffort: 'max'` for Jamis and the research subagent. Stage 4's trace-reviewed comparison rejected Fireworks Flash, DeepSeek V4 Pro, Qwen3.8 Max, GLM-5.2, and Kimi K3 for policy behavior. This is a quality-first selection for the initial rollout, not a claim that Terra is the permanent cost optimum. Fireworks was configured for observational memory at decision time; observational memory moved to NeuralWatt when the provider changed. Keep model selection in code so changes remain visible in Git review.
- Require live evidence before Jamis states a verification-required claim. Model memory and model confidence do not count as evidence. An existing dedicated live tool, such as `weatherTool`, may supply evidence for its own domain; other online verification goes through `researchAgent`.
- Treat the following as verification-required: current or changeable facts; numbers, dates, or quotations; named-person or organization status; product or API behavior; high-stakes matters; and recommendations that depend on external facts.
- For Firecrawl research, prefer one relevant primary source: official documentation, a government or standards body, original research, a direct company statement, or an original dataset. When no primary source exists, require two independent established secondary sources. Anonymous blogs, content farms, forums, and social posts are leads only unless the post itself is the subject being verified.
- For Firecrawl-researched claims, put a `[1]`-style marker beside each supported claim and end the answer with at most three titled source URLs. A dedicated live domain tool follows its existing response contract unless the answer also contains Firecrawl-researched claims.
- If Firecrawl fails or the available sources do not meet the evidence standard, withhold the requested factual claim and say plainly that it could not be verified. Do not answer from model memory and do not switch to another web tool.
- Instruct `researchAgent` to perform at most one search and read at most three pages. Set the Firecrawl search result limit to three and `maxSteps: 5` on `researchAgent`. The search-call and page-read counts are operational targets; only the per-search result limit and Mastra step limit are code settings.
- Scrape main-content markdown with `maxAge: 0` and `storeInCache: false` so verification neither reuses Firecrawl's default cache for current claims nor adds the fresh scrape to that cache. This is not Firecrawl Zero Data Retention. Standard provider-side handling is accepted for public URLs and page content in this version; private context and secrets must never enter Firecrawl inputs.
- Keep Mastra's `includeSubAgentToolResultsInModelContext` default of `false`, so raw nested tool results are not automatically forwarded to Jamis's model. The subagent can still quote page content in its memo. Accept that full scrape tool results remain stored in the existing private Postgres message records and ClickHouse spans; they are not omitted from observability and may persist indefinitely because the current storage configuration has no TTL or pruning policy.
- Use only execution controls Mastra already provides. Mastra `maxSteps` limits sequential model calls, while `toolCallConcurrency` limits simultaneous calls. Neither is a cumulative page budget, so no custom budget hook, counter, or mutable per-run state will be added. Traces measure whether the agent respects the operational budget.

## Alternatives not taken

- **Firecrawl tools directly on Jamis.** This removes one model call but mixes source discovery, source evaluation, and conversation ownership in one prompt and toolset. It also weakens the scoped ownership established in [ADR 0009](0009-jamis-as-mastra-supervisor.md).
- **Mastra `webFetchTool`.** It is useful for directly reading a supplied URL but does not provide Firecrawl search or extraction. Adding it would also create the fallback path that was explicitly rejected.
- **Mastra `webSearchTool`.** It delegates search to supported model providers rather than Firecrawl, creating the rejected fallback path.
- **Give every subagent direct research access.** Mastra can express nested delegation by explicitly attaching an agent to another agent, but doing so now adds routing paths, cost, and harder traces without a demonstrated need.
- **A code router or separate verifier now.** Deterministic routing or a verifier could catch more failures, but it adds another decision layer and model call before the category-based policy has been evaluated.
- **Custom cumulative tool-call enforcement.** Mastra exposes hooks that could block calls, but it does not expose a declarative total-call budget. A custom counter is unnecessary until traces show a real overuse problem.

## Consequences

- Jamis can accept an explicit online-research request, delegate source discovery and page reading, and answer from the returned evidence.
- Jamis remains the single conversation owner and public agent. Research results are evidence for its response, not ready-made replies.
- Future sibling subagents cannot call `researchAgent` automatically. Jamis can research first and pass the resulting evidence in a later delegation.
- Mastra may add a resolved subagent's tools to its authenticated runtime tool registry. Studio and authenticated operator endpoints can therefore list or execute the Firecrawl tools, but sibling agents still cannot select them unless their own configuration explicitly grants access.
- The research subagent receives no prior parent messages, but it still receives Jamis's delegation prompt and Mastra `RequestContext`. Keeping unrelated conversation and secrets out of the prompt and tool inputs limits private-context exposure.
- The initial 1.59 analysis found an unexpected `messageFilter` exception would continue with unfiltered history. The deliberately trivial synchronous filter and sentinel smoke reduce this risk but do not turn it into a fail-closed guarantee. Production's 1.61 filter-error behavior is not yet re-proven; revisit the documented native error strategy when a released package exposes it.
- Online research adds latency, Firecrawl usage, and at least one additional model call whenever it runs.
- Terra max also raises the cost of ordinary Jamis conversation because Jamis owns routing and final cited answers, not only research delegation. A split where only `researchAgent` uses Terra would leave verification routing, claim selection, and citations to a model that failed the Stage 4 policy matrix. A future casual-versus-verification model router may reduce cost, but needs a separate decision because it introduces a new routing boundary.
- Before any model change or a cost-based routing decision, compare private trace usage for Jamis and the research subagent: input, output, and reasoning tokens; model latency; delegation rate; Firecrawl calls; and policy-matrix results. Use actual provider invoices and trace data to establish a baseline before adding a hard budget, threshold, or fallback.
- A Firecrawl outage produces a candid refusal for affected research and factual requests rather than a lower-confidence answer.
- Source selection, routing, citations, rejection of instructions found in scraped pages, and the three-page operational target remain model-driven behavior. Initial real-model checks and production traces are required because these are not hard code invariants.
- The code-enforced starting bounds are three results per search and five research steps. The instruction-level targets are one search and three page reads. If trace-reviewed coverage is poor, first try five results, five reads, and eight steps. If category routing is repeatedly poor, broaden research to all factual requests; if unsupported claims persist, prefer a separate verifier as the long-term architecture.
- Scraped public page bodies increase private Postgres and ClickHouse retention volume. The existing private storage and access boundary, including potentially indefinite retention without a TTL, is accepted for this first version. Add pruning or payload filtering only if observed volume or sensitivity requires it.
- Firecrawl may retain request data under its standard service policy even with response caching disabled. Zero Data Retention is deferred while research inputs are restricted to public queries, URLs, and page content.
- `NEURALWATT_API_KEY` remains required for observational memory; `OPENAI_API_KEY` and `FIRECRAWL_API_KEY` become part of the application and deployment contract.

## Future model evaluation record

Treat a model change as a reviewed architecture decision, not a pricing tweak. Record the candidate model and effort setting, the reason to evaluate it, provider pricing observed at the time, and the result of the same real-model matrix used in Stage 4. Preserve trace IDs, final operator-visible responses, sources, tool counts, refusal behavior, latency, and token usage for both Jamis and the research subagent. Record reasoning activity and token counts, not raw chain-of-thought. A model replaces Terra only after it satisfies the policy matrix and a human approves the corresponding ADR and plan update.
