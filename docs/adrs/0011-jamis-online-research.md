# Jamis online research through a Firecrawl-powered research subagent

Jamis will gain online research as a first-class capability by delegating to one internal research subagent that owns Firecrawl search and single-page scrape tools. The subagent discovers relevant public webpages and reads selected pages; Jamis remains the only public agent and owns the final answer. Evidence requirements constrain how Jamis uses this capability for factual answers.

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
- Use `openai/gpt-5.6-terra` with `openai.reasoningEffort: 'max'` for Jamis and the research subagent. Stage 4's trace-reviewed comparison rejected Fireworks Flash, DeepSeek V4 Pro, Qwen3.8 Max, GLM-5.2, and Kimi K3 for policy behavior. This is a quality-first selection for the initial rollout, not a claim that Terra is the permanent cost optimum. Fireworks remains configured for observational memory. Keep model selection in code so changes remain visible in Git review.
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
- `FIREWORKS_API_KEY` remains required for observational memory; `OPENAI_API_KEY` and `FIRECRAWL_API_KEY` become part of the application and deployment contract.

## Future model evaluation record

Treat a model change as a reviewed architecture decision, not a pricing tweak. Record the candidate model and effort setting, the reason to evaluate it, provider pricing observed at the time, and the result of the same real-model matrix used in Stage 4. Preserve trace IDs, final operator-visible responses, sources, tool counts, refusal behavior, latency, and token usage for both Jamis and the research subagent. Record reasoning activity and token counts, not raw chain-of-thought. A model replaces Terra only after it satisfies the policy matrix and a human approves the corresponding ADR and plan update.
