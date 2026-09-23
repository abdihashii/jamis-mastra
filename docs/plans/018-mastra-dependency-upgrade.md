# 018: Mastra dependency upgrade

Status: **Stages 1 and 2 complete locally; push and deployment are not approved.**

Linear: [JAM-71](https://linear.app/abdirahman-haji/issue/JAM-71/upgrade-mastra-dependencies-to-current-stable-releases).

Upgrade the six direct Mastra packages as one compatible set. Preserve the current Postgres, ClickHouse, Sendblue, workflow, memory, authentication, observability, and Fantasy behavior. Fix only regressions caused by the upgrade.

## Version decision

The ticket's 2026-09-20 UTC targets were superseded by npm releases published on 2026-09-22 UTC. Use the current stable versions reported by the official package pages:

| Package | Current | Target |
| --- | ---: | ---: |
| `@mastra/core` | 1.61.0 | 1.68.0 |
| `@mastra/observability` | 1.17.1 | 1.17.9 |
| `@mastra/clickhouse` | 1.15.2 | 1.20.0 |
| `@mastra/pg` | 1.21.1 | 1.26.0 |
| `@mastra/memory` | 1.27.0 | 1.31.0 |
| `mastra` | 1.25.0 | 1.31.0 |

The `@mastra/core@1.67.0` release notes identify two breaking changes: queued-message subscriptions were renamed and an Archil filesystem method was renamed. This repository uses neither API. The subsequent 1.68.0 changelog adds no breaking change relevant to this repository, and `@mastra/pg@1.26.0` requires core 1.68 or newer.

## Stage 1: Upgrade the package set

**Goal:** Update the six direct dependencies together, refresh only their required lockfile graph, verify peer compatibility, and repair only compile, lint, or build regressions caused by the upgrade.

**Critical files:**

- `package.json`
- `bun.lock`
- Mastra integration files only if the installed contracts require compatibility edits

**Verification:** Confirm exact direct versions and peer ranges from installed package metadata. Re-read the installed package docs, exported types, and migration notes. Run `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run build`, and `rtk git diff --check`.

**Demo:** `bun pm ls` reports the six target versions, and the production build completes without a Mastra compatibility warning.

**Proposed commit:** `chore: upgrade Mastra dependencies`

**Implementation record:** Committed as `ba5cb83` after exact-version, peer-range, installed-contract, typecheck, lint, build, and diff verification.

## Stage 2: Verify Jamis behavior and API discovery

**Goal:** Prove the upgraded package set preserves the ticket's runtime boundaries. Add no new behavior, dependency, abstraction, or storage migration.

**Critical files:**

- Existing Fantasy, Sendblue, authentication, observability, monitoring, incident-triage, memory, and workflow tests
- Compatibility files from Stage 1 only if a verified runtime regression remains
- This plan for the verification record

**Verification:** Run the focused boundary tests, then `rtk bun test`, `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun run build`, and `rtk git diff --check`. Start the local server, confirm `/api/system/api-schema`, and use the installed `mastra api` CLI to list representative tools and workflows. Confirm `fantasyWeeklyRecapWorkflow` remains registered with cron `0 10 * * *` and its configured timezone behavior.

**Demo:** Direct `mastra api` discovery returns the existing tool and workflow schema, including the Fantasy scheduled workflow, without invoking an agent, workflow, delivery, deployment, or production mutation.

**Proposed commit:** `test: verify Mastra upgrade contracts`

## Verification record

Verified on 2026-09-23 UTC with the current stable package set. Installed docs and declarations confirm the existing composite Postgres and ClickHouse vNext storage, scheduled workflow, Observational Memory, SimpleAuth, channel, request-context, and span-output-processor contracts remain valid. No compatibility change was required outside exposing the existing Fantasy schedule object so its cron and timezone have a direct regression assertion.

- Focused Fantasy, configured-league isolation, monitoring, scheduling, sanitization, Sendblue, authentication, observability, and incident-triage checks: 136 passed.
- Full repository gate: 322 tests passed across 22 files, with typecheck, lint, build, and `git diff --check` passing.
- Local API smoke: `/api/system/api-schema` returned 369 routes; `mastra api` discovered the existing 10 tools and `fantasy-weekly-recap`; the read-only schedule registry returned active schedule `wf_fantasy-weekly-recap` with cron `0 10 * * *` and timezone `America/Chicago`.
- No agent, workflow, delivery, push, deployment, or production mutation was performed.

## Research basis

- [Mastra releases](https://github.com/mastra-ai/mastra/releases) documents the breaking changes between the repository's previous core version and 1.67.0. The [`@mastra/core@1.68.0` changelog](https://github.com/mastra-ai/mastra/blob/@mastra/core@1.68.0/packages/core/CHANGELOG.md) documents the release published on 2026-09-22 UTC.
- The official npm registry reports [`@mastra/core@1.68.0`](https://registry.npmjs.org/@mastra%2fcore/latest). The official npm pages for [`@mastra/observability`](https://www.npmjs.com/package/@mastra/observability), [`@mastra/clickhouse`](https://www.npmjs.com/package/@mastra/clickhouse), [`@mastra/pg`](https://www.npmjs.com/package/@mastra/pg), [`@mastra/memory`](https://www.npmjs.com/package/@mastra/memory), and [`mastra`](https://www.npmjs.com/package/mastra) report the other target stable versions above as of 2026-09-22 UTC.
- [Mastra's documentation index](https://mastra.ai/llms.txt) contains no migration guide for these same-major package updates, so installed docs and type declarations remain the contract source after installation.

## Approval discipline

Implement and verify one stage at a time. Show the diff and proposed commit, then wait for explicit approval before committing. Commit approval does not authorize push, deployment, production smoke, or any other external mutation.
