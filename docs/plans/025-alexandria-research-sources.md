# 025: Alexandria research sources (JAM-74)

Status: implemented, reviewed, committed, and deployed on the JAM-74 feature branch. Stage 1: `7e84cca`; Stage 2: `6c3848b`. Both production iMessage smokes and trace inspections passed on 2026-10-01 UTC. All acceptance criteria met; pending PR review and merge.

## Resolved scope

- JAM-63 is complete. Keep Perplexity as the default webpage search provider and Firecrawl as the page reader.
- Only the internal research subagent gains specialized sources. It automatically chooses Developer Index for code/API questions, Research Index for paper-based questions, and ordinary webpage research for other tasks. Jamis retains delegation and the final answer.
- Allow retrieved abstracts as evidence only for findings explicitly stated in them, labeled abstract-only. Distinguish these from retrieved full-text passages and from unread discovery metadata.
- Research search may return ten papers. Developer search initially returns at most three records, with up to three matched passages per record. At most three sources may be cited.
- The operator authorizes automatic Developer executions whose verified maximum cost is at most six credits per call. Block unknown, unbounded, or higher costs. Do not assume the operator's approximate 5,000-credit subscription establishes remaining credits.
- Use one discovery route per task and at most one additional contract inspection if necessary. At most three record-fetching calls total, including index search and webpage scrapes. Tools remain sequential. A paper search leaves two further reads. Retain instruction-based task budgets and verify actual counts in traces.
- No automatic cross-provider fallback, application retry loop, arbitrary provider execution, writes, terms acceptance, new dependencies, agent hierarchy, or unapproved production deployment. Production deployment was subsequently authorized after Stage 2 sign-off, as recorded below.

## Fresh evidence (2026-10-01 UTC)

Perplexity discovery and Firecrawl extraction found a September 29 [ChatGPT/Codex plugin announcement](https://www.firecrawl.dev/blog/alexandria-chatgpt-codex). It adds Alexandria and Developer Index to that plugin and describes automatic web fallback and optional organization-enabled agent acceptance of terms. Those behaviors are excluded from Jamis. Freshly extracted [Research](https://docs.firecrawl.dev/features/research) and [Developer](https://docs.firecrawl.dev/features/developer) docs match the saved September 27 research exactly.

Current [Alexandria documentation](https://docs.firecrawl.dev/features/alexandria) still requires discovering capabilities, inspecting inputs/pricing, and executing selected tools. Discovery descriptions are not evidence. Missing provider terms require an admin handoff, never automatic acceptance.

Free SDK catalogue inspection found five index capabilities: Developer `search`; Research `search`, `inspect`, `read`, and `related`. Initial execution support needs only Developer `search`, Research `search`, and Research `read`. Omit citation expansion and the separate abstract-inspection operation unless a demonstrated source requirement needs them.

Protocol smokes using installed `firecrawl@4.41.0`:

- Research `search`, `k: 10`: ten records with abstracts, canonical identifiers, no source URL field; reported zero credits, approximately 2.3 seconds. First paper: `arxiv:2005.11401`, internal paper ID `4998431230678779659`.
- Research `read`, `k: 3`: three nonempty passages plus paper metadata, original arXiv ID, creation/update dates; reported zero credits. This proves passage access, not whole-paper reading or index freshness.
- Developer `search`, `k: 3`, `passages: 3`: three records, reported two credits total, approximately 1.2 seconds. One primary-source SDK README and two `web:` fallback records. The fallback records remain webpage candidates requiring scraping.
- Full catalogue includes `creditsCost: 2`, `perRecord: true`, and `recordsPerUnit: 10` for Developer search. Compact discovery omitted the billing-unit field. Do not implement the earlier interpretation of two credits for every individual record: conservatively validate the maximum charge, account for billing units only when their semantics are established, and report actual returned credits separately.

Ignored raw artifacts: `.pplx/web/01e02234.json`, `.firecrawl/jam-74-*`. Request identities and exact payloads were saved before execution. No terms were accepted.

## 1. Add bounded structured-source tools

**Goal:** Independently executable tools discover supported sources and retrieve validated, attributable evidence without attaching them to an agent yet.

**Critical files:** `src/mastra/tools/research-sources.ts`, its focused contract test, `docs/CONTEXT.md`, ADR 0011, and this plan.

**Implementation:** Use one cohesive module and the installed Firecrawl SDK. Expose the minimum domain-based discovery/retrieval surface, with finite paper/developer operations and validated inputs. Provider names, arbitrary execution options, raw catalogue contracts, and SDK types stay internal. Discovery uses a bounded catalogue request restricted to the supported indexes, with full options/response details, rather than open-ended provider selection or catalogue pagination.

Retain inspected contracts only for the current delegated task using the existing Mastra request context. Verify isolation against the installed Mastra API: delegation context entries are shallowly copied, so create new task-local values rather than mutating inherited objects. Retrieval must not trust agent-supplied prices or capability contracts. No global mutable contract cache, adapter registry, or new budget framework.

Normalize retrieved evidence with original source identifier, canonical citation URL when deterministically derivable, title, content, evidence kind, UTC retrieval timestamp, and available source dates/license/attribution. Preserve unknown dates. Support canonical arXiv, PubMed/PMC, and DOI identifiers conservatively; unsupported provenance yields an explicit gap. Internal numeric paper IDs alone cannot serve as original provenance. `web:` records are candidates requiring the existing scraper, even if the upstream response contains excerpts.

Enforce capability allowlisting, bounded result/passages counts, and known maximum pricing before execution. Generate and retain request identity before each execution. Preserve installed transport semantics; do not add retries or generate replacement identities after uncertain outcomes. Validate every result item and inner success/partial status. Empty or malformed evidence never becomes a supported finding. SDK rejection of missing credits is an unknown outcome/cost, never zero.

Expose safe failure categories and a validated admin action URL for terms-required failures, without raw upstream errors. Existing spans record source/capability, latency, outcome, request identity, and reported credits or unknown. Do not add query, record-content, credential, or raw-error logging beyond existing private tool records.

**Verification:** Focused local HTTP fixtures cover supported success shapes, empty discovery/results, malformed provenance/content, partial and `web:` results, per-item failures, billing-unit fields, unknown/excessive pricing, terms/access failures, credit errors, timeouts, request identity, no application retry, safe telemetry, and task-context isolation. Run `bun run typecheck`, `bun run lint`, `bun test` with disposable Postgres, `bun run build`, and `git diff --check`.

**Demo:** Execute the actual new tools directly: free discovery, ten-paper search, one bounded passage read, and one Developer search. Show normalized evidence, original identifiers/URLs, request identity, actual credits, and correct treatment of webpage fallback candidates. Raw SDK smokes above are the baseline, not substitutes for this tool demo.

**Proposed commit:** `feat: add bounded Alexandria research sources`

Stop after verification and show the diff summary. Commit only after explicit sign-off; begin Stage 2 after that commit. Push requires separate approval.

### Stage 1 results (2026-10-01 UTC)

- Added `research-source-discover` and `research-source-retrieve` in one module, using the installed SDK with no dependency changes. At Stage 1 verification, neither tool was attached to an agent. Discovery accepts only `papers` or `developer`; retrieval accepts only paper search/read or Developer search. Counts and provider routes remain internal constants.
- Inspected contracts belong to the exact Mastra request-context instance. Installed Mastra 1.71.0 delegates by shallow-copying entries (`listAgentTools`); the fixture reproduces that copy and proves inherited contracts cannot authorize retrieval, new discovery cannot mutate the parent's state, and runtime contract state is absent from serialized context. Updates replace state and retain execution identities before sending requests.
- Developer search uses a conservative six-credit maximum for three records, without discounting the catalogue's ten-record billing unit. Actual returned charges remain separate. Papers require a verified zero-credit contract. Unknown prices, unsupported contracts, or bounds above the permitted maximum block execution.
- Normalized evidence includes original IDs/canonical URLs, content, evidence kind, UTC retrieval time, and available dates/license/attribution. Missing or ambiguous dates remain null. `web:` records contain no evidence content and explicitly require scraping. Unsupported original provenance produces a gap.
- Local HTTP fixtures cover success and empty/malformed discovery, all supported provenance families, empty/malformed/partial evidence, failed records/passages, webpage candidates, credit and billing-unit validation, terms/access failures, execution-deadline failures, safe telemetry, and task isolation. The SDK's built-in 502 retries preserve identical bodies and request IDs; the module adds no retry. Missing credits and uncertain outcomes remain unknown.
- Gates: `bun run typecheck`, `bun run lint`, `bun run build`, and `git diff --check` pass. Full `bun test`: 376 passed, zero failed, across 30 files. Both `DATABASE_URL` and `JAMIS_TEST_DATABASE_URL` point to disposable loopback Postgres for this gate; setting only the latter initially left four legacy fantasy/calendar checks without their fixture database.
- Security review checked input-to-execution, credentials/telemetry, task ownership, and cross-module integration sequentially. No exploitable findings remain. APOSD/ponytail review kept the provider contracts, failure translation, pricing, and provenance inside one cohesive module with two domain tools. No registry, global contract cache, budget framework, or agent changes were added.
- Explicit pre-commit reviews found two correctness issues, now fixed: valid SDK error items without routing fields retain their access/terms classification and admin URL, while successful items still require exact routing; malformed ISO/RFC calendar dates remain null instead of rolling forward. Regression cases failed before each fix and pass afterward, including valid leap-day/timezone conversions and rejection of missing or mismatched success routing. Security review found no introduced exploitable path; ponytail review found no worthwhile complexity cuts. Bun's advisory check reported pre-existing advisories in unchanged dependencies.

Direct tool demos, using separate paper and Developer contexts:

| Operation | Observed output | Reported credits | Request identity |
| --- | --- | --- | --- |
| Paper discovery | Search/read contracts, no evidence | 0 | `adce94e9-0555-40d7-a9c4-e4f8a185534f` |
| Paper search | Ten abstract-only sources with original arXiv IDs/URLs | 0 | `ff42cdc7-f5ec-4c61-a039-315fb097acc0` |
| Paper read | Three joined passages for `arxiv:2005.11401`, 11,805 characters; original dates retained | 0 | `94d435f9-422d-42f4-af25-0df0c24b1128` |
| Developer discovery | Search contract, conservative maximum six credits | 0 | `0e3d548b-3b37-45c4-a4dc-e9052ae94e5d` |
| Developer search | One SDK README passage with AGPL-3.0 attribution and two `web:` candidates requiring scraping | 2 | `535f3f49-44ec-4428-a01b-347d7a7fd56d` |

Paper citation: `https://arxiv.org/abs/2005.11401`. Developer citation: `https://github.com/firecrawl/firecrawl/blob/33c042fd1e3c61f103b40dce41bd0381ff70e287/apps/go-sdk/README.md`. An earlier Developer query returned two supported records and one unsupported-provenance gap; the cap was not widened. These tool demos establish protocol behavior, not agent answer quality or index freshness.

Ignored demo artifacts: `.firecrawl/jam-74-stage1-tools-smoke.ts` and `.firecrawl/jam-74-stage1-tools-smoke-result.json`. Existing glossary definitions already cover Stage 1. These isolated demos preceded Stage 2 routing/budget/quality verification below. Stage 1 committed as `7e84cca` after operator sign-off; pushing and deployment were authorized later. No terms were accepted.

## 2. Connect the research subagent and verify quality

**Goal:** Jamis answers scientific and technical questions using retrieved structured evidence while preserving webpage behavior and failure policy.

**Critical files:** `src/mastra/agents/research-agent.ts`, `src/mastra/agents/jamis.ts`, incident-triage component mappings and their test, focused research checks, ADR 0011, and this plan.

**Implementation:** Attach the new tools only to `researchAgent`. Instructions select the source automatically, define discovery versus record retrieval, retain the combined three-retrieval budget, and require actual retrieved content for structured claims. Retain primary-source quality, untrusted-content handling, private-context filtering, adjacent citations, and insufficient-evidence refusal. A terms-required result may report its actionable admin URL without making unsupported factual claims or accepting terms. Keep ordinary webpages subject to scraping. Preserve historical triage mappings when adding new IDs.

Start with `maxSteps: 5`; increase only if traces prove the valid discovery/three-retrieval/final-memo flow cannot complete. Do not change models or reasoning effort.

**Verification:** Run all standard gates again. Review real Jamis traces for tool selection, sequential calls, retrieval count, actual reads, evidence kinds, citations, refusal, safe telemetry, and private-context isolation.

**Demo:** Compare a fixed set on the ordinary webpage path and specialized path: a paper's stated method/result, a claim supported only by an abstract, a documented library/API behavior, and an unavailable-evidence case. Record evidence coverage, unsupported-claim failures, latency, and credits. Require sourced scientific and technical answers with adjacent citations and correct refusal when evidence is inadequate. If three Developer records miss essential evidence, report the measured gap and revisit the cap before widening it. No production A/B router or benchmark service.

**Proposed commit:** `feat: use Alexandria evidence in online research`

Stop after verification for explicit commit sign-off. Close with repository-wide gate totals and the final commit list. Push, deployment, and messaging-channel smokes require separate authorization.

### Stage 2 results (2026-10-01 UTC)

- Attached structured-source tools only to `researchAgent`. Updated its instructions for automatic paper/Developer/webpage selection, one discovery route, at most one additional contract inspection, three combined retrieval calls, original provenance, abstract-only labels, and insufficient-evidence refusal. Ordinary search remains Perplexity; page reading remains Firecrawl.
- Kept the model, reasoning effort, and `maxSteps: 5`. Set native `toolCallConcurrency: 1`. Jamis's existing delegation hook surface clears parent-added instructions and pins the research run to five steps, retaining the subagent's own policy. The installed SDK adds parent instructions to the original policy; its execution path omits an empty addition, preserving that policy. A runtime fixture proves an attempted instruction override and three-step limit cannot truncate a four-step discovery/search/read/memo flow. Separate delegations retain isolated contracts and exclude unrelated parent conversation.
- Jamis accepts citations from retrieved structured evidence as well as scraped webpages, labels abstract-only findings, and permits only the validated admin URL as access metadata on a terms-required refusal. It explicitly prohibits redelegating the same research question to bypass the task budget. New incident component mappings preserve historical webpage IDs.
- Read version-matched Mastra documentation for subagent request-context copying, delegation hooks, generation/concurrency options, and exported spans; checked installed source for instruction merging and the five-step hook behavior. No new dependency, agent hierarchy, retry loop, or budget framework.
- Final standard gates pass: typecheck, lint, 377 tests across 31 files with disposable Postgres, build, and whitespace checks. Initial agent comparisons used disposable local storage and unique smoke threads, with captured private artifacts only. Subsequent authorized production/channel verification is recorded below.

Fixed questions, same model/reasoning settings, comparing current specialized routing against a smoke-only copy of the Stage 1 webpage agent:

| Question | Webpage path | Specialized path | Webpage / specialized retrieval calls | Webpage / specialized latency |
| --- | --- | --- | --- | --- |
| RAG-Sequence versus RAG-Token, full-text support | Supported, adjacent citations to scraped original PDF | Supported, adjacent citations to retrieved original passages | 1 / 2 | 63.5s / 55.2s |
| RAG abstract's stated language-generation comparison | Supported, labeled abstract-only | Supported, labeled abstract-only | 1 / 1 | 34.5s / 28.3s |
| Firecrawl JS SDK request identity after uncertain execution | Correct refusal after three reads lacked the needed SDK evidence | Supported, three Developer records followed by two original README page reads | 3 / 3 | 75.6s / 97.8s |
| Exact result in an unavailable named paper | Exact insufficient-evidence refusal | Exact insufficient-evidence refusal despite unrelated index records | 1 / 1 | 27.9s / 23.6s |

All final runs used one research delegation and one discovery, sequential tool execution, and at most three retrieval calls. The synthetic unrelated-private-context marker appeared in no delegation prompt or tool input. Final factual sentences have adjacent citations; sources match retrieved original content. Operation metadata remains the established allowlist without query/content/credential/raw-error logging. Paper index operations reported zero credits; Developer search reported two credits. Existing webpage tools do not expose credit receipts, so webpage costs remain unknown. These single-run observations establish representative behavior, not a general quality or speed improvement.

Controlled source failures with the real Jamis model also passed: terms-required yielded only the refusal plus the exact validated admin URL (20.1s); an execution-deadline failure yielded only the refusal and unknown cost (19.6s). Each made exactly two source calls (discovery and failed execution), with no retry or fallback. No provider terms were accepted.

The first Developer answer omitted a sentence-level citation on an imperative SDK usage step; the clarified instruction and rerun fixed it. An earlier webpage comparison redelegated the same question and exceeded the total budget before its five-minute smoke deadline. The explicit no-redelegation instruction fixed that path: the final comparison stopped at one delegation/three reads and refused correctly. No cap was widened; the specialized path verified the SDK answer within the existing three-read cap.

Ignored evidence: `.firecrawl/jam-74-stage2-jamis-smoke.ts`, the controlled-failure wrapper, `jam-74-stage2-evidence-check.ts`, and `jam-74-stage2-*.json`/logs. The final webpage Developer artifact is `jam-74-stage2-web-developer-final.json`; earlier failed runs remain separate historical observations. Stage 2 committed as `6c3848b` after operator sign-off.

Requested independent reviews completed after code/testing: correctness, contracts/Mastra lifecycle, security, and ponytail/module boundaries. Security found no exploitable issues; ponytail found no worthwhile cuts. Review found that safe failure outputs ended as successful spans and therefore bypassed error-filtered incident triage. Fixed the shared source operation wrapper: upstream/access/unknown-outcome/invalid-response failures record a fixed safe span error without ending the span or changing its neutral output. Success, partial, empty, blocked, and terms-required outcomes remain normal results.

The regression failed before the fix and now passes through local HTTP source responses, real Mastra tool execution/export, storage-equivalent error-derived status, and status-filtered incident triage. It covers both source components, all four hard-failure categories, normal gaps, and absence of raw provider diagnostics. Final gates still pass (377 tests across 31 files). A real-model controlled timeout rerun retained the exact refusal, unknown cost, and exactly two source calls without retry/fallback. Fresh code/security/ponytail re-reviews found no remaining issues or worthwhile cuts. The operator approved the Stage 2 commit, branch push, and deployment; completion evidence follows.


## Deployment and production channel acceptance (2026-10-01 UTC)

- Implementation commits: `239ac8f` (plan/vocabulary), `7e84cca` (bounded tools), and `6c3848b` (agent wiring, evidence policy, triage integration).
- After explicit commit/push/deployment approval, pushed `abdirahman/jam-74-add-firecrawl-alexandria-sources-to-jamis-online-research` and deployed it using `infra/deploy.sh`. Production revision `6c3848b2aa89257dfb19c1c359e08ed127aedf4d` was verified at `2026-10-01T03:29:38Z`. All four services were running; authenticated API returned 200; researchAgent exposed exactly webSearch, webScrape, researchSourceDiscover, and researchSourceRetrieve. Compiled modules contained the structured tools and safe span-error fix. No main-branch merge was performed.
- The operator sent both public questions through iMessage and provided the visible replies. The corresponding agent and channel traces were inspected, not inferred from reply text alone.

| Production question | Agent trace | Retrievals / limit | Research steps / limit | Reported credits | End-to-end latency |
| --- | --- | --- | --- | --- | --- |
| RAG abstract comparison | `7415b4350d94ba99914fa2b3b5cd9ac8` | 1 / 3 | 3 / 5 | 0 | 31.7s |
| Firecrawl JS SDK request identity | `bd159863f6fab1020749da2d4f0db48d` | 3 / 3 | 5 / 5 | 2 index; page costs unknown | 81.9s |

Both traces had exactly one research delegation and one catalogue discovery, no error spans, no repeated search/delegation or provider fallback, and sequential calls. The subagent's initial model context contained its system policy and one user message with only the current public research prompt. Each returned factual sentence had an adjacent citation. The abstract finding matched the retrieved abstract and was explicitly labeled abstract-only. The SDK guidance matched the actually scraped original README at its pinned commit. Channel spans matched by the existing digest recorded reply acceptance; the operator also supplied the received text.

Research-operation metadata contained only the established operation fields. Broader model-step telemetry still retains response headers, including cookie/turn-state fields; that predates JAM-74 and is tracked separately in [JAM-78](https://linear.app/abdirahman-haji/issue/JAM-78/restrict-model-response-headers-retained-in-traces). No exploitable credential leak was established. No header values or raw private traces are committed. The sanitized inspection summary is ignored at `.firecrawl/jam-74-imessage-trace-report.json`; full trace artifacts remain private and ignored.

## Acceptance criteria completion

- [x] JAM-63 neutral web contracts/defaults retained.
- [x] Discovery never treated as evidence; only finite read-only capabilities execute.
- [x] Contracts, provenance/attribution, counts, access behavior, and bounded pricing checked.
- [x] Original provenance/content retained; abstract-only and full-text passages distinguished.
- [x] Web citations require scrapes; structured citations require retrieved evidence; refusal/privacy/source-quality policies retained.
- [x] One discovery route and combined three-retrieval budget documented and trace-verified; sequential execution and five-step limit retained.
- [x] No automatic provider fallback, application retry, or new-identity repeat after an uncertain outcome.
- [x] Empty/malformed/failed sources cannot support answers; terms URL and timeout refusal verified.
- [x] New operation telemetry stays allowlisted; hard failures reach triage with fixed safe errors.
- [x] Focused contracts, direct source smokes, agent comparisons, and production channel traces verified.
- [x] CONTEXT, ADR 0011, and this plan updated.
- [x] Final repository gates pass: typecheck, lint, 377 tests across 31 files, build, and whitespace checks.
