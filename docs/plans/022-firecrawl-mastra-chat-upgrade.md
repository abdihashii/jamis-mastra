# 022: Firecrawl, Mastra, and Chat SDK upgrade

Status: **Stage 1 verified, awaiting commit approval. Stage 2 pending.**

Branch: `chore/firecrawl-mastra-chat-upgrade`. No ticket, per operator clarification.

Upgrade the requested packages to the npm stable versions verified on 2026-09-26 UTC. Preserve the existing research, Sendblue, authentication, memory, Postgres, ClickHouse, scheduling, and observability contracts. Keep Sendblue 0.2.0, which is already current.

## Version decision

| Package | Current | Target |
| --- | --- | --- |
| `firecrawl` | 4.32.2 | 4.41.0 |
| `chat` (currently transitive) | 4.38.0 | 4.41.0 |
| `@mastra/core` | 1.68.0 | 1.71.0 |
| `@mastra/memory` | 1.31.0 | 1.32.1 |
| `@mastra/observability` | 1.17.9 | 1.18.1 |
| `@mastra/pg` | 1.26.0 | 1.27.1 |
| `@mastra/clickhouse` | 1.20.0 | 1.21.1 |
| `mastra` | 1.31.0 | 1.31.3 |

Firecrawl now automatically resumes certain processing timeouts. Set `autoResume: false` on the existing scrape call to preserve its previous timeout and error behavior. Keep freshness settings and the existing result schemas.

The operator requires exact version pins for the upgraded packages. Pin Chat SDK directly to 4.41.0 so its runtime version is controlled by the root manifest as well as the lockfile. Existing code already imports Chat SDK types; no new integration is introduced.

Mastra 1.71 enables eager execution for eligible tools in `Agent.stream()`. The operator approved adopting the released behavior and verifying it with synthetic model responses. No inference provider or model change is part of this upgrade.

## 1. Upgrade Firecrawl and preserve scrape failures

**Goal:** Pin Firecrawl 4.41.0, update only its required lockfile graph, and preserve the current scrape timeout behavior.

**Critical files:** `package.json`, `bun.lock`, `src/mastra/tools/firecrawl.ts`, one focused Firecrawl regression test, and this plan.

**Verification:** Run typecheck, lint, the full test suite against disposable local Postgres, build, and `git diff --check`. A synthetic processing-timeout response must fail after one request without an automatic resume. Keep all requests on the local test server.

**Demo:** `bun pm ls` reports Firecrawl 4.41.0; the Firecrawl tool's local HTTP smoke returns search and scrape data, rejects missing markdown, and rejects a processing timeout without reissuing the request.

**Proposed commit:** `chore: upgrade Firecrawl and preserve scrape timeout behavior`

## 2. Upgrade Mastra and Chat SDK, then verify integration behavior

**Goal:** Upgrade the six exact Mastra pins as one compatible set, add an exact Chat SDK 4.41.0 pin, and resolve a single SDK copy. Repair only verified upgrade regressions.

**Critical files:** `package.json`, `bun.lock`, existing integration tests, any necessary compatibility edits, and this plan.

**Verification:** Read the newly installed docs and declarations. Verify peer ranges, then run typecheck, lint, all tests, build, and `git diff --check`. Exercise actual Sendblue webhook dispatch with synthetic inputs through Chat SDK and Mastra state. Verify DM/group isolation, deduplication, invalid-secret rejection, existing auth/observability boundaries, and eligible tool execution with the chosen timing. Confirm generated build dependencies match the targets.

**Demo:** The built server's authenticated API schema still lists the existing tools and Fantasy workflow; synthetic channel inputs route correctly without outbound messages or external model requests.

**Proposed commit:** `chore: upgrade Mastra and Chat SDK integrations`

## Baseline

The unchanged repository passes 354 tests across 26 files when pointed at disposable local Postgres. Earlier four failures came from missing database access. Test databases and local protocol fixtures do not use production storage or send messages.

Stage 1 passes 355 tests across 27 files, typecheck, lint, build, and `git diff --check`. The new local HTTP regression covers result normalization, freshness flags, missing markdown, and processing-timeout failure without resumption. Both installed and generated build dependencies report Firecrawl 4.41.0. Only Firecrawl's manifest and package entries changed in the lockfile.

## Research

- [Firecrawl direct scrape source](https://github.com/firecrawl/firecrawl/blob/main/apps/js-sdk/firecrawl/src/v2/methods/scrape.ts), verified against the npm 4.41.0 archive, documents automatic resume and its opt-out.
- [Chat SDK 4.41.0 changelog](https://github.com/vercel/chat/blob/chat%404.41.0/packages/chat/CHANGELOG.md) documents mention routing, thread isolation, and lock renewal changes.
- [Mastra core 1.71.0 changelog](https://raw.githubusercontent.com/mastra-ai/mastra/%40mastra%2Fcore%401.71.0/packages/core/CHANGELOG.md) documents eager tool execution and intervening channel/history fixes.
- npm stable metadata and integrity-verified package archives are saved under ignored `.firecrawl/`. Research artifacts stay uncommitted.

## Approval discipline

Complete and verify one stage, show its diff summary and proposed commit, and wait for explicit approval before committing or starting the next stage. Push and deployment require separate approval. Finish with the full repository gate and final commit list.
