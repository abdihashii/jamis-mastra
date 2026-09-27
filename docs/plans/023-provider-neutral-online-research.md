# 023: Provider-neutral online research (JAM-63)

Status: **Stage 1 committed and pushed. Stage 2 complete, verified, and approved for commit. Stage 2 push and deployment are not approved.**

Baseline: `main` at `e024d8f`, including PR #35. Firecrawl remains pinned to 4.41.0; retain `autoResume: false` and its processing-timeout regression. No dependency upgrade is part of this work.

## Resolved scope

- Perplexity is the default search provider. Firecrawl remains manually selectable for search through `WEB_SEARCH_PROVIDER=firecrawl`; absent configuration defaults to `perplexity`. Reject other values at startup.
- Firecrawl is the only page-reading provider. The operator explicitly removed Perplexity scraping from JAM-63. Do not add an inert `WEB_SCRAPE_PROVIDER` setting.
- Call the Perplexity Search API directly with native `fetch`, not a subprocess or an additional SDK. The web-research skill informs source discovery and reading; its CLI commands, five-result research recipe, retries, and provider fallback do not replace Jamis's existing policy.
- Keep the normalized contracts: search accepts `{ query }` and returns `{ results: [{ title: string | null, url: string }] }`, with at most three candidates; scrape accepts `{ url }` and returns `{ markdown: string }` with nonempty page content.
- Preserve research ownership, delegation-context filtering, model selection, one-search/three-scrape instructions, sequential tool use, `maxSteps: 5`, source quality, scraped-source citations, and the existing insufficient-evidence refusal. These budgets remain instruction-based, not newly enforced counters.
- Never fall back to a different provider. Preserve the installed Firecrawl SDK's existing transport behavior and the explicit processing-timeout opt-out; do not add application retries.

## Deep module boundary

Use one cohesive module, `src/mastra/tools/web.ts`, with only two exported tools: `webSearch` (`id: web-search`) and `webScrape` (`id: web-scrape`). It owns provider selection, startup credential validation, upstream request shapes, result normalization and validation, provider-neutral execution errors, and safe operation telemetry. Neither callers nor tool input/output schemas receive provider names, provider options, SDK response types, or upstream error payloads.

Keep provider-specific functions private in that module. Do not split providers into public adapters, add an adapter interface, expose a generic action/provider tool, or create a registry. Mastra already supplies the tool boundary and execution observability. Attach only provider, operation, elapsed milliseconds, and success/error outcome under `webOperation` on the existing tool span's metadata; an empty search is a successful operation. Do not add queries, URLs, page content, credentials, or raw exceptions to telemetry. Existing tool-input and page-result retention stays unchanged. Keep the production log threshold unchanged: installed observability defaults to `warn`, so `info` operation logs would be discarded.

Scraping always needs `FIRECRAWL_API_KEY`; Perplexity search additionally needs `PERPLEXITY_API_KEY`. Firecrawl-only search and scraping must start without a Perplexity key. Invalid provider configuration and missing selected credentials fail during startup; unused providers are not initialized.

The rename also touches incident triage. Add the neutral component IDs and registration-key mappings while retaining the existing Firecrawl component mappings for historical traces. Do not rewrite stored traces or broaden the incident reader's query policy. Jamis's citation instructions must say online research rather than Firecrawl research.

## 1. Neutralize the boundary while retaining Firecrawl

**Goal:** Research uses provider-neutral tools and errors while both operations still run through the current Firecrawl SDK. This is a complete, reviewable change before adding a service.

**Critical files:** Rename `src/mastra/tools/firecrawl.ts` to `src/mastra/tools/web.ts`; update `research-agent.ts`, the provider-specific wording in `jamis.ts`, incident-triage component mappings and their existing test, and the Firecrawl tool regression test (renamed to the neutral web-tool test). Capture the source vocabulary in `docs/CONTEXT.md` and append a scoped amendment to ADR 0011 rather than rewriting its historical decisions.

**Implementation:** Export only `webSearch` and `webScrape`; make both agent instructions and schemas provider-neutral. Clamp search candidates to three and validate normalized provider data inside the module. Empty search is `{ results: [] }`; missing or blank page markdown is an execution failure. Convert upstream failures to static search/scrape errors, with no exception cause or raw provider payload escaping. Add safe telemetry through the existing Mastra facility. Preserve `maxAge: 0`, `storeInCache: false`, `onlyMainContent: true`, and `autoResume: false`.

**Verification:** Use the existing local HTTP fixture for success, empty search, upstream search/scrape failure, missing/blank markdown, result capping, provider-data exclusion, telemetry fields, and processing timeout without automatic resume. Existing triage tests cover both historical and neutral registration keys. Run `bun run typecheck`, `bun run lint`, `bun test` against disposable local Postgres, `bun run build`, and `git diff --check`.

**Demo:** Execute `webSearch` directly against Firecrawl using a public query, then execute `webScrape` against one returned public source. Verify only candidate titles/URLs and page markdown are returned, both operations identify Firecrawl in safe telemetry, and the actual research-agent toolset contains only the neutral tools. Record observations, not raw credentials or page bodies, in this plan.

**Proposed commit:** `refactor: hide Firecrawl behind neutral web tools`

Stop after verification and present the diff summary and proposed commit. Wait for explicit commit approval before committing or beginning Stage 2.

### Stage 1 verification record (2026-09-27 UTC)

- After review fixes, typecheck, lint, build, and `git diff --check` pass. The full repository suite passes 356 tests across 28 files against disposable local Postgres. The expanded web contract fixture and the incident mapping fixture also pass independently (22 tests).
- The Firecrawl 4.41.0 processing-timeout regression still proves one request without automatic resume. Search and scrape upstream failures become static neutral errors, and missing/blank markdown fails rather than supplying evidence. Real Mastra tool-span exports retain only provider, operation, duration, and outcome in `webOperation`, preserve existing metadata, and contain only neutral failure messages. The focused web test has 130 assertions and exercises the production-default log threshold rather than a stub-only logger.
- A live direct-tool smoke after the fixes searched `IANA example domains official documentation` and returned exactly three candidates: `https://www.iana.org/help/example-domains`, `https://www.iana.org/domains/reserved`, and `https://www.iana.org/news/2024/example-domain-http-methods`. It read the first page and returned 952 markdown characters. Both operations succeeded; observed search and scrape durations were 534 ms and 1,107 ms respectively. Safe operation metadata survived actual span export.
- The actual `researchAgent.listTools()` result contains only registration keys `webSearch` and `webScrape`, with IDs `web-search` and `web-scrape`. Its resolved instructions and description contain neither provider name. No model request or channel message was made.
- The disposable test database is removed after verification. Smoke artifacts remain under ignored `.firecrawl/jam-63-stage1-smoke.*`. The build still resolves Firecrawl 4.41.0. No dependency, environment-template, Docker, or infra change is included in Stage 1.
- Review corrections restore the top search candidate, three-result request/schema limits, PR #35's scrape settings, one-character queries, and one-character nonblank markdown. Regression checks cover each case, and the follow-up Mastra review finds no remaining code regression. The operator approved the Stage 1 commit and push after reviewing these fixes.

## 2. Add Perplexity search and make it the default

**Goal:** The same search capability supports Perplexity by default and Firecrawl by explicit selection; all page reading remains Firecrawl.

**Critical files:** `src/mastra/tools/web.ts`, its focused contract/configuration test, `.env.example`, `.env.prod.example`, the scoped ADR 0011 amendment, and this plan. No package, lockfile, Docker, or infra changes are expected.

**Implementation:** Validate `WEB_SEARCH_PROVIDER` against `perplexity` and `firecrawl` at startup. For Perplexity, POST to `https://api.perplexity.ai/search` with Bearer authentication, `query`, `max_results: 3`, and `search_context_size: medium`. Keep response snippets, dates, and other upstream fields private; candidates alone cannot establish evidence. Use a private fixed request timeout, with no application retry or fallback. Validate the provider response before returning the shared normalized contract. Document both provider variables and credential requirements in the environment templates.

**Protocol boundary first:** Before making Perplexity the default, execute a direct public-query API smoke with the configured key and prove the actual response shape. Both local credential variables are present as of 2026-09-27 UTC; this is not yet proof that either service accepts them. Do not print key values or authorization headers.

**Verification:** Reuse the same local HTTP contract cases for Perplexity and Firecrawl search and Firecrawl scrape. Verify startup rejects invalid selection, requires Perplexity only when selected, and always requires Firecrawl for page reading. Use isolated processes where import-time configuration needs independent environments; do not add a public test-only factory or production endpoint configuration. Cover non-2xx, invalid JSON, malformed results, empty results, bounded candidates, provider-neutral errors, and safe success/failure telemetry. Run the complete standard gates again.

**Demo:** Run the same direct search query once with each search provider in separate processes, and scrape a selected source with Firecrawl. Record provider, elapsed time, outcome, and returned candidate URLs for manual comparison without asserting a search-quality winner from one sample. Then run a real Jamis research request with the default Perplexity search plus Firecrawl reading. Review actual tool counts, scraped cited URLs, evidence memo, final citations, and safe telemetry. Keep smokes off the messaging channel unless a handset smoke is separately requested. No production deployment is included.

**Proposed commit:** `feat: default online research search to Perplexity`

Stop after verification and present the diff summary and proposed commit. Wait for explicit commit approval. Push and deployment need separate confirmation. Finish with the repository-wide gates, observed smoke results, and final commit list.

### Stage 2 verification record (2026-09-27 UTC)

- Native Perplexity protocol smoke accepted the existing credential before changing the default. The response contained `id` and `results`; each candidate included title, URL, snippet, date, and last-updated fields. Only title and URL cross the tool boundary. Requests use three results, medium context, and a private 30-second timeout.
- Isolated local HTTP fixtures pass for both search providers and Firecrawl reading. Startup tests prove absent selection defaults to Perplexity, explicit Perplexity works, Firecrawl-only operation needs no Perplexity key, scraping always needs Firecrawl, and invalid/empty/case-mismatched selections fail. Contract cases cover empty/bounded candidates, missing titles, malformed results, invalid JSON, non-2xx failures, neutral errors, safe success/error telemetry through actual Mastra export, no retry/fallback, and Firecrawl processing timeout without resumption. A missing-URL Firecrawl result now fails validation rather than being silently discarded.
- Repository-wide typecheck, lint, build, and `git diff --check` pass. The full suite passes 358 tests across 28 files against disposable local Postgres. No package, lockfile, Docker, infra, model, agent policy, or channel change is included.
- Direct tool smokes used the same query, `IANA example domains official documentation`, in separate processes. Both providers returned `https://www.iana.org/help/example-domains`, `https://www.iana.org/domains/reserved`, and `https://www.iana.org/news/2024/example-domain-http-methods`. Perplexity search took 199 ms; manually selected Firecrawl search took 552 ms. Firecrawl read the first page successfully in each process (952 markdown characters, 1,170 ms and 1,156 ms respectively). These observations do not establish a search-quality winner. Exported metadata contains only provider, operation, duration, and outcome; research still exposes only the two neutral tool IDs.
- A real request through the existing Jamis agent and model gateway asked what IANA reserves example.com and example.org for and whether they can be registered or transferred. Trace `ec4fc690f2895809d4738c78c5d48045` completed in 29,661 ms with one research delegation, one Perplexity search (1,339 ms), and one Firecrawl read (1,157 ms, 2,287 markdown characters), sequentially. The delegation prompt contained only the public task. The verified evidence memo mapped three findings to the scraped `https://www.iana.org/domains/reserved`; the final answer cited that page beside both factual claims and included the required `Sources:` heading. A separate read of the cited page verified the documentation, illustrative-use, and no-registration-or-transfer statements. The smoke used disposable storage and in-memory telemetry and sent no messaging-channel reply.
- Independent read-only correctness and tests/contracts reviews found no verified regression; the four-lane security audit found no introduced exploitable vulnerability. Ponytail review found nothing to cut. Native `bun audit` reports the existing high `js-yaml@3.15.1` advisory through `gray-matter` (GHSA-2883-xcg3-v3hh), already recorded during Stage 1. Dependency remediation remains separate.
- Smoke and evidence artifacts remain ignored under `.firecrawl/jam-63-stage2-*`; the disposable database was removed after the closing gates. The operator approved the Stage 2 commit on the existing branch: `feat: default online research search to Perplexity`. Push and deployment require separate approval.

## Research evidence

- [Perplexity Search API reference](https://docs.perplexity.ai/api-reference/search-post): direct POST `/search`, Bearer authentication, normalized candidate fields available in `results`, and request result limits. Scraped locally to ignored `.firecrawl/jam-63-perplexity-search.md`.
- [Perplexity Search quickstart](https://docs.perplexity.ai/docs/search/quickstart): native REST usage and extraction context settings. Scraped locally to ignored `.firecrawl/jam-63-perplexity-quickstart.md`.
- [Perplexity CLI documentation](https://docs.perplexity.ai/docs/cli/overview): the CLI is a research-session aid; its full-page fetch command is deprecated. Scraped locally to ignored `.firecrawl/jam-63-perplexity-cli.md`.
- [Perplexity Agent API fetch tool](https://docs.perplexity.ai/docs/agent-api/tools/fetch-url-content): model-mediated extraction may be truncated and includes failure markers. This informed the operator's decision to exclude Perplexity page reading. Scraped locally to ignored `.firecrawl/jam-63-perplexity-fetch-url.md`.
- PR #35, installed `firecrawl@4.41.0` source, and the existing regression test establish the Firecrawl freshness and processing-timeout behavior to preserve.
- Installed `@mastra/core@1.71.0` docs, declarations, and runtime establish `createTool`, `context.tracing.currentSpan.update`, and neutral registration keys. Installed `@mastra/observability@1.18.1` defaults to `warn`, independently reproduced with in-memory export. No framework API is assumed from older versions.

### Artificial Analysis comparison (checked 2026-09-27 UTC)

The [public Search Index leaderboard](https://artificialanalysis.ai/agents/search-api), with latest data dated 2026-09-22, scores Perplexity Search medium at 80, Perplexity Search high at 79, Octen highlights at 77, Parallel advanced and Brave LLM context at 75, and Firecrawl Search at 73. This supports retaining the approved Perplexity medium default as a starting choice, not adding a third provider in JAM-63.

The [benchmark methodology](https://artificialanalysis.ai/methodology/search-api) uses GPT-5.6 Luna medium, up to 10 results per search, 25 turns, unlimited tool calls within that turn budget, provider-native payloads, and a separate page-fetch tool. It retries search-provider errors until success. Jamis instead has one search, three title/URL candidates, three page reads, and a no-fallback refusal policy. These scores therefore do not establish Jamis's accuracy, latency, or outage behavior. Benchmark artifacts are saved under ignored `.firecrawl/jam-63-artificial-analysis-search*.md` and `.pplx/jam-63-search-benchmarks/`.

Research artifacts remain ignored and uncommitted. No new ADR is warranted for this reversible provider choice; ADR 0011 needs a narrow amendment so its Firecrawl-only wording does not contradict the new boundary.
