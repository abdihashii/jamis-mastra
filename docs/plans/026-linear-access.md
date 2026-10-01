# 026: Confirmed Linear issue access (JAM-64)

Status: draft. No implementation or live Linear credential smoke completed.

Linear: [JAM-64](https://linear.app/abdirahman-haji/issue/JAM-64/give-jamis-confirmed-access-to-jamis-linear-issues).

## Resolved scope

- Jamis owns the existing operator iMessage DM. `personal-accounts-agent` owns Linear tools alongside Gmail and Calendar. Linear events never invoke Jamis.
- Use a distinct Jamis Linear app actor with OAuth `client_credentials`, on-box client credentials, and access tokens held only in runtime memory. Request only necessary issue read/write scopes, never admin or Linear-native agent scopes.
- Configure app access for `jamis` and enforce its pinned team ID for every issue read and mutation. Create always uses that team; all referenced issues in relationships must belong to it.
- Read list/filter/search results, details/status, comments, and attachment names/links. Identify partial pages and ambiguous references without guessing.
- Support creation, comments, status, permitted issue fields, and in-team parent/duplicate/blocks/related relationships. Inventory the current API fields rather than assuming a historical SDK contract.
- Show the exact proposed change. Only the operator's immediately following `confirm` in the same DM and active Jamis DM session authorizes it. Other next messages cancel; `/new` clears proposals and sequences.
- Proposals are durable and single-use. Several field updates on one issue form one proposal. Stale issues require a fresh proposal and confirmation.
- Multiple requested changes proceed in order, one confirmation each. Success presents the next proposal automatically; decline, failure, or uncertain outcome stops the sequence.
- Retry once silently only when no mutation demonstrably occurred. A possibly applied mutation is not retried and requires inspection.
- Exclude team moves, project/cycle assignment or management, comment editing/deletion, issue archive/unarchive/deletion, and attachment file transfers.
- Treat issue/comment content as untrusted data. Credentials and tokens never enter model output, stored messages, or exported traces.

## Delivery and evidence

This feature introduces external authentication, issue-domain logic, durable write state, and new security checks. Deliver four separate stages, starting with credentials and the team boundary before agent behavior depends on them.

Existing decisions: [ADR 0012](../adrs/0012-jamis-hitl-as-text-checks.md), [ADR 0015](../adrs/0015-personal-accounts-agent.md), [ADR 0022](../adrs/0022-confirm-linear-issue-writes-in-text.md), and [ADR 0010](../adrs/0010-keep-imessage-conversations-continuous.md).

Repo evidence checked on 2026-10-01 UTC:

- `src/mastra/channels/sendblue.ts` validates operator DMs, serializes their execution, intercepts login and `/new`, and handles time-zone confirmation before the default agent handler. Session rollover cancels conversational state before creating the fresh thread.
- `src/lib/operator-time-zone.ts` supplies the existing Bun SQL transaction/table pattern. Its local setting mutation is not a complete solution for remote Linear writes or uncertain outcomes.
- `src/mastra/agents/jamis.ts` isolates personal-account delegation history, uses thread-scoped Observational Memory without retrieval, and keeps Sendblue tool display hidden.
- Installed Mastra 1.71.0 channel types and Sendblue 0.2.0 preserve the text-channel limitation recorded in ADR 0012. Use application-enforced text confirmation; do not introduce approval cards or streaming.
- Package/runtime is Bun. Existing account integrations use `fetch`; start with that and installed Zod, not a new SDK, provider interface, or generic approval framework.

Linear references: [OAuth](https://linear.app/developers/oauth-2-0-authentication) and [app actors/team access](https://linear.app/developers/agents). Current scopes, token behavior, writable fields, relationship operations, mutation failure semantics, and concurrency guarantees still need primary-source verification. Record the verified contracts here during their stages; this draft does not claim live API verification.

## Verification and sign-off

After every implementation stage, run `rtk bun run typecheck`, `rtk bun run lint`, `rtk bun test`, `rtk bun run build`, and `rtk git diff --check`. Point both `DATABASE_URL` and `JAMIS_TEST_DATABASE_URL` at disposable loopback PostgreSQL for the test gate. Keep fixture HTTP/model/channel traffic stubbed; live demos are separate observations.

Present the diff, verification totals, demo evidence, and proposed commit after each stage. Wait for explicit commit approval before committing or beginning the next stage. Push and production deployment require separate authorization. Update this plan and the ticket's acceptance checkboxes only for observed results.

For operator-run credential setup or handset smokes, give one step and expected output, then wait before the next step. Never ask the operator to paste a secret or access token into chat.

## 1. Prove app credentials and the team boundary

**Goal:** A real Jamis app token reads its identity and the pinned team through a narrow client, with no issue mutation exposed.

**Critical files:** new `src/lib/linear.ts` and focused client tests, new `scripts/linear-smoke.ts` and `docs/setup-linear.md`, `.env.example`, `package.json`, and production environment wiring only where required.

**Implementation:** Verify the current `client_credentials` grant, minimum scopes, app identity, token expiry, and team-access configuration against primary sources. Document on-box provisioning and recovery. Add `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and `LINEAR_TEAM_ID` configuration without secrets in source. Verify the pinned ID resolves to `jamis` and the expected app identity is observable; do not infer identity from a token merely succeeding.

Use a small `fetch` client with validated inputs/results, bounded network waits, safe error categories, and runtime-only token reuse until expiry. Authentication failures must not fall back to the operator's token. Keep token requests and raw upstream errors outside tool results and tracing. The smoke prints only safe identity/team evidence, never tokens or credentials. Do not attach tools to an agent yet.

**Verification:** Stub token and GraphQL HTTP boundaries. Cover valid identity/team reads, expired/rejected credentials, missing/mismatched team configuration, malformed responses, timeout, and secret-safe errors. Run the full gate.

**Demo:** `rtk bun run scripts/linear-smoke.ts` authenticates with real on-box credentials and reports the Jamis app identity and pinned `jamis` team. Confirm configured team access in Linear. No mutation endpoint or tool is available in this stage.

**Proposed commit:** `feat: add team-bound Linear app authentication`

## 2. Add bounded issue reads

**Goal:** The operator receives real, team-bound Linear issue data through Jamis.

**Critical files:** `src/lib/linear.ts`, new `src/mastra/tools/linear.ts` and focused tests, `src/mastra/agents/personal-accounts-agent.ts`, `src/mastra/agents/jamis.ts`, and the smoke script.

**Implementation:** Add a finite read surface for list/filter/search, issue details/status, comments, and attachment metadata. Choose explicit input/result bounds and cursor handling from the verified API contract. Scope list/search queries to the pinned team and recheck membership before returning directly addressed issues or their nested data. Do not treat an empty search as proof a cross-team target is permitted.

Expose stable issue identifiers/links, requested data, partial-page indicators, and safe unavailable/not-found/ambiguous outcomes. Validate response shapes and avoid raw GraphQL payloads/errors. Resolve ambiguous references through operator clarification, not newest-match selection. Update delegation instructions to include Linear and current Calendar support; retain isolated personal-account history and existing Gmail/Calendar behavior. No write tool exists yet.

**Verification:** HTTP fixtures cover each read operation, pagination/truncation, ambiguous references, cross-team IDs and results, empty/malformed data, unavailable service, untrusted content, and safe output. Run account delegation regressions and the full gate.

**Demo:** Run direct-tool reads first. Then, over iMessage, retrieve JAM-64, request comments/attachment metadata, and answer a backlog query using real data. A cross-team identifier is refused; a partial result is labeled partial.

**Proposed commit:** `feat: let Jamis read jamis Linear issues`

## 3. Enforce one durable confirmed write

**Goal:** Create, title/description/status update, and add-comment operations execute once only after exact next-message confirmation.

**Critical files:** new `src/lib/linear-proposals.ts` and focused PostgreSQL tests, `src/lib/linear.ts`, `src/mastra/tools/linear.ts`, `src/mastra/channels/sendblue.ts`, its channel/session tests, and the two agent instruction files.

**Implementation:** Inventory the current create/update fields and exclusions. Add only the initial operations here. Persist validated operation data, source message identity, external DM identity, active Mastra session identity, stale-check evidence, and execution state using the existing Postgres/Bun SQL pattern. Proposal data contains no credentials, access tokens, or channel objects.

Verify installed Mastra delegation/request-context behavior before passing proposal authority to the account tool. Bind authority to the validated operator turn and active session outside model-supplied inputs; retain runtime-only channel capabilities outside serialized context and trace exports. Studio, other channels, nonoperator messages, and untrusted issue text cannot authorize writes.

Publish the exact proposal through the existing channel boundary and allow confirmation only after successful proposal posting. Intercept confirmation/cancellation in the serialized operator DM path before any agent turn. Reuse ordering and duplicate-delivery behavior without relying solely on provider timestamps. Cancel on every other next message, including intercepted login commands, and integrate `/new` cancellation without replayed commands clearing newer state. Preserve time-zone confirmations and ordinary DM handling.

Claim execution durably before sending a mutation. A restart or duplicate delivery cannot send a claimed mutation again. Recheck team membership, allowed fields, and stale evidence before execution. Verify Linear's available conditional-update or conflict behavior; do not claim a read-then-write check is atomic. If the API cannot guarantee the agreed stale-write behavior, resolve that limitation before shipping this stage.

Separate proven rejection/no-mutation failures from uncertain outcomes. Permit at most one silent retry for the former. Timeouts, lost responses, or crashes after a send may be uncertain and must not trigger replay. Failed notification posting must not repeat a successful mutation. Persist enough safe outcome state to report recovery accurately; never report an unknown outcome as success. Fail closed if proposal persistence or channel acceptance is uncertain.

**Verification:** Use real disposable Postgres with stubbed Linear/Sendblue HTTP. Cover confirm/cancel/other messages, multi-field update, repeated confirmation, duplicate delivery, restart before/after claim, lost mutation responses, stale issues, team changes, denied contexts, failed proposal/result posting, one safe retry, and `/new` current/replayed commands. Exercise native channel dispatch and time-zone/login/session regressions, not only helper functions. Scan stored messages and exported trace fixtures for seeded secrets. Run the full gate.

**Demo:** Directly exercise the proposal/confirmation boundary first. Over iMessage, cancel a change and verify Linear is unchanged; confirm one change and inspect it in Linear; replay confirmation without a second mutation; change a proposed issue externally and observe a fresh proposal. Exercise create/update/comment on operator-designated demo issues. No automatic sequence yet.

**Proposed commit:** `feat: gate Linear writes with durable text confirmation`

## 4. Complete issue fields, relationships, and sequencing

**Goal:** The agreed issue surface works within the same gate, and multiple requested changes require separate ordered confirmations.

**Critical files:** `src/lib/linear.ts`, `src/lib/linear-proposals.ts`, `src/mastra/tools/linear.ts`, their focused tests, channel tests, and account-agent instructions.

**Implementation:** Complete the verified field inventory and record supported/excluded fields in `docs/setup-linear.md`. Reject unsupported or excluded fields rather than dropping them. Validate field values and referenced metadata against the allowed team/API surface; reassess stale evidence for every referenced issue affected by a relationship.

Add in-team parent/duplicate/blocks/related operations using verified mutation semantics. Every referenced issue must pass membership checks both at proposal and execution. Relationship direction and exact requested values must appear in the proposal.

Store the remaining finite requested sequence with the proposal state. Only the current item is actionable. After confirmed success, prepare and post the next item using fresh issue state; previously planned data is not preauthorization. Decline, failure, uncertain outcome, or `/new` stops the sequence. If posting the next proposal fails, leave no unseen actionable proposal. Extend the existing state module without a new workflow engine or generalized approval registry.

**Verification:** Cover representative values across the field inventory, excluded operations, cross-team issue/metadata references, relationship direction, stale related issues, sequence order, duplicate/restart handling, next-proposal posting failure, and cancellation/uncertainty stopping remaining items. Close with the full repository gate and credential/trace leak checks.

**Demo:** Over iMessage, change representative metadata and an in-team relationship; inspect exact results in Linear. Complete a two-change request with two separate confirmations, then demonstrate cancellation and uncertain-first-outcome stopping the second change. Verify excluded/cross-team requests are refused. Finish with production reads and one operator-designated confirmed write after separately authorized deployment.

**Proposed commit:** `feat: complete confirmed Linear issue changes and sequencing`

## Completion

Record verified Linear contracts, each stage's test totals and demo observations, approved commit IDs, deployment authorization, and production smoke/trace inspection evidence. Link this plan from JAM-64 and mark acceptance criteria complete only after their corresponding checks. Do not include live credentials, raw tokens, or private issue content in these records.
