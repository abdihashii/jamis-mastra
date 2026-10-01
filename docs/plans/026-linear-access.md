# 026: Confirmed Linear issue access (JAM-64)

Status: Stages 1 and 2 approved for local commits. Stage 3 narrowed by operator decision to confirmed creation only; updates and comment creation blocked by the strict stale-write requirement. Handset smoke remains deferred until separately authorized deployment.

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

Linear references: [OAuth](https://linear.app/developers/oauth-2-0-authentication) and [app actors/team access](https://linear.app/developers/agents). Stage 1 authentication contracts are recorded below. Writable fields, relationship operations, mutation failure semantics, and concurrency guarantees still need primary-source verification during their stages. Documentation verification does not establish a successful live credential smoke.

Stage 1 primary-source verification (2026-10-01 UTC): Firecrawl Developer lookup
and full official OAuth/app/actor pages, plus Linear's published GraphQL schema,
confirm `client_credentials` yields an app actor, 30-day `expires_in`, no refresh
token, comma-separated requested scopes, and Bearer GraphQL authorization.
`viewer { id name app }` observes the app user; `team(id: String!) { id name key }`
resolves the pinned team. App team access initially includes all public teams and
can be restricted after first token generation in installed app details. Secret
rotation invalidates client-credentials tokens; changing scopes revokes existing
app tokens. See [setup guidance and source links](../setup-linear.md).

Stage 1 requests only `read`, the minimum for identity/team metadata. The later
issue-update stage requires `write`; coordinate that scope change rather than
granting unused mutation permission now. No native-agent/admin scope is requested.
Identity validation requires `viewer.app` and the Jamis name; its ID is reported
for operator comparison. It is not inferred from token success. Writable fields,
mutation failure semantics, and concurrency contracts remain unverified and are
gated in their later stages.

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

Stage 1 observations (2026-10-01 UTC): typecheck, lint, build with Studio, and
diff whitespace checks passed. Full Bun gate passed **387 tests across 32 files,
zero failures**, with both database variables targeting disposable loopback
PostgreSQL `jamis_sessions_test`. The new client contributes 10 focused HTTP
fixture checks. No external model/channel traffic was used in this gate.
Review-code (independent correctness, API/test contract, and security passes)
found no verified defects. Ponytail review found no unnecessary complexity.
Live local smoke passed before and after the operator restricted installed-app
team access to `jamis` only and confirmed the intended app identity in Linear.
Both runs reported app user `7207c952-99d3-424c-abd8-d405facd0d5f`, name `jamis`,
`app: true`, and team `62db635f-aa68-484c-9458-f4d48b92236c`, name `jamis`, key
`JAM`. No tokens or credentials were printed; no issue mutation was available.
The team-access selection is operator-confirmed, not inferred from a team query.
JAM-64's real credential/team checkbox is now checked. Production runtime smoke
and deployment have not been performed; local `.env.prod` provisioning does not
prove VPS configuration.
The operator approved the Stage 1 commit on 2026-10-01 UTC with the proposed
message above. The operator authorized Stage 2 implementation after the commit.
Push and deployment remain unapproved.

## 2. Add bounded issue reads

**Goal:** The operator receives real, team-bound Linear issue data through Jamis.

**Critical files:** `src/lib/linear.ts`, new `src/mastra/tools/linear.ts` and focused tests, `src/mastra/agents/personal-accounts-agent.ts`, `src/mastra/agents/jamis.ts`, and the smoke script.

**Implementation:** Add a finite read surface for list/filter/search, issue details/status, comments, and attachment metadata. Choose explicit input/result bounds and cursor handling from the verified API contract. Scope list/search queries to the pinned team and recheck membership before returning directly addressed issues or their nested data. Do not treat an empty search as proof a cross-team target is permitted.

Expose stable issue identifiers/links, requested data, partial-page indicators, and safe unavailable/not-found/ambiguous outcomes. Validate response shapes and avoid raw GraphQL payloads/errors. Resolve ambiguous references through operator clarification, not newest-match selection. Update delegation instructions to include Linear and current Calendar support; retain isolated personal-account history and existing Gmail/Calendar behavior. No write tool exists yet.

**Verification:** HTTP fixtures cover each read operation, pagination/truncation, ambiguous references, cross-team IDs and results, empty/malformed data, unavailable service, untrusted content, and safe output. Run account delegation regressions and the full gate.

**Demo:** Run direct-tool reads first. Then, over iMessage, retrieve JAM-64, request comments/attachment metadata, and answer a backlog query using real data. A cross-team identifier is refused; a partial result is labeled partial.

**Proposed commit:** `feat: let Jamis read jamis Linear issues`

Stage 2 contracts verified (2026-10-01 UTC): Linear's current published schema
deprecates `issueSearch`; use `searchIssues(term:, filter:)`. Its `teamId` is a
ranking boost, not an access filter. Both list and search use explicit
`filter.team.id.eq` and recheck returned team IDs. `issue(id:)` exposes nested
comments/attachments with `first`/`after` and `pageInfo.hasNextPage/endCursor`.
Installed Mastra 1.71.0 docs/types confirm createTool's schema validation,
execution context/abort signal, and `noopObserve` for direct execution.

Implemented finite read filters and result bounds are recorded in
[setup guidance](../setup-linear.md#stage-2-read-surface-and-smoke). Title
references always return candidates for exact-identifier clarification; they
never select the first match. Tokens remain in the runtime closure, outside tool
inputs/results and HTTP traces. No write tool or mutation exists.

Direct-tool live smoke passed: JAM-64 details/status, comments (empty), and
attachments (empty), plus backlog and search pages. The latter explicitly report
partial pages and cursors. A synthetic foreign prefix was denied before issue
resolution. No issue/comment text or credentials were printed in the smoke.

Final Stage 2 gate (2026-10-01 UTC): typecheck, lint, Studio build, and whitespace
checks passed. Full suite passed **399 tests across 33 files, zero failures**,
against disposable loopback PostgreSQL with both database variables set to
`jamis_sessions_test`. The clean-environment focused suite passed **22 checks**,
including native account delegation, Gmail/Calendar registration, history
isolation, and credential-free exported spans/tool results.

Review-code found an unusable ambiguity cursor and a missing isolated webhook
secret fixture. Both were corrected and independently rechecked; no findings
remain. Ponytail and security reviews found no unnecessary complexity or
verified vulnerabilities. The final direct-tool live smoke passed again.

The operator confirmed Sendblue routes to VPS production. The over-iMessage
demo therefore needs a separately authorized deployment. Handset behavior has
not been observed and its ticket acceptance criterion stays unchecked. On
2026-10-01 UTC, the operator approved the Stage 2 commit with handset smoke
deferred until separately authorized deployment. Push, deployment, and Stage 3
remain unapproved.

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

**Proposed commit (create-only slice):** `feat: gate Linear issue creation with durable text confirmation`

Stage 3 contract investigation (2026-10-01 UTC): implementation is not complete.
The operator retained the strict stale-write guarantee and rejected substituting
a final reread with a documented concurrent-edit race. Updates remain blocked.
Comments also lack a precondition on the referenced issue, so the same guarantee
cannot currently be established for them. Creation has no existing issue revision.
The operator explicitly authorized implementing a create-only slice, with updates
and comment creation unavailable. The original full Stage 3 goal remains incomplete.

Create-only slice: one independently committable implementation, extending the
existing client/tool/channel and adding `src/lib/linear-proposals.ts`. Acceptance:
the disposable-Postgres native channel fixture posts the exact proposal, sends
one create only for the next exact `confirm`, and never resends a claimed create
after replay, restart, or response loss. Verification uses the full gate below;
live scope changes and handset creation still require separate operator setup/demo.

Primary-source evidence:

- Linear's [published schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
  exposes `issueUpdate(id: String!, input: IssueUpdateInput!)`. The complete input
  has no expected revision, timestamp, or conditional filter. `lastSyncId` is an
  output on `IssuePayload`, not an accepted update precondition. `commentCreate`
  accepts `CommentCreateInput`, likewise without an issue revision precondition.
  A read followed by either mutation cannot enforce the strict guarantee against
  another writer. No documented HTTP conditional-write alternative was found.
- Initial field inventory: create supports `teamId`, `title`, `description`,
  and `stateId`; update supports `title`, `description`, and `stateId`; comments
  support `issueId` and `body`. Create/comment inputs accept a caller-provided
  UUID v4 `id`, but that alone does not establish safe retry semantics. The schema
  also permits excluded fields such as update `teamId` and `trashed`, so a future
  tool must strictly allowlist inputs rather than forward arbitrary field objects.
- Official [GraphQL error handling](https://linear.app/developers/graphql#error-handling)
  explicitly allows partial success with HTTP 200 and an `errors` array. Neither
  a generic GraphQL error nor a lost response proves no mutation occurred.
  [Rate-limit documentation](https://linear.app/developers/rate-limiting#handling-rate-limit-errors)
  specifies HTTP 400 with `RATELIMITED`; HTTP status alone is insufficient to
  classify a mutation as safely retryable. No live writes or retry experiments ran.
- Official [OAuth documentation](https://linear.app/developers/oauth-2-0-authentication#client-credentials-tokens)
  confirms `write` is needed for updates and changing client-credentials scopes
  revokes existing app tokens. No scope change or token generation was performed.
- Installed Mastra 1.71.0 `listAgentTools` clones request-context entries into a
  new `RequestContext` before `onDelegationStart`, dropping parent memory/thread
  keys. The existing Sendblue capability WeakMap is keyed by the original context
  and therefore does not automatically authorize the delegated account tool.
  Native channel dispatch resolves the active memory thread inside the default
  handler. Future implementation must bind the actual parent session and propagate
  authority outside serialized proposal data and exported trace context.

Create-only slice observations (2026-10-01 UTC): **407 tests across 34 files,
zero failures** in the final full Bun gate. Both database variables targeted
disposable loopback PostgreSQL `jamis_sessions_test`. Typecheck, lint, Studio
build, and diff whitespace checks passed. The isolated native/durability
subprocess contributes **10 additional fixture checks** (reported separately
from Bun's parent-process total), with only stubbed Linear, Sendblue, and failed
device-login HTTP. No credentials, token requests, or mutations were sent to
live services.

Observed fixture behavior includes exact proposal posting, no mutation before
confirmation, one create for a valid next-message `confirm`, equal-timestamp
confirmation, cancellation/login/rollover, replayed `/new`, provider-history gaps,
session changes, denied channel/tool contexts, simultaneous time-zone arbitration,
concurrent claims, restart before/after claim, lost claim acknowledgements,
uncertain mutation responses, failed/rejected proposal posting, result-notification
recovery, one preflight retry, and credential-free memory/tool/trace results on
success and failure. App clients uniformly use the minimal `read,issues:create`
scope set; no `write` or `comments:create` permission is requested.

Review-code's correctness, contracts/tests, concurrency, and channel integration
passes were performed sequentially, as were security-audit and ponytail-review.
Review found the installed Sendblue adapter permits resolved HTTP-success payloads
with status `ERROR`, while Chat SDK discards the raw status in `Thread.post`.
The adapter boundary now validates acceptance before that discard; rejected and
malformed responses cannot authorize a proposal. This was covered by a native
rejection fixture and a finite acceptance test. The existing production trace
sanitizer was reused, two old channel mocks gained transaction support, and a
redundant posting state was removed. No verified review findings remain. No new
dependency, approval framework, workflow engine, or infrastructure was introduced.

Live create/scope-transition and handset demos have not run. Scope changes would
revoke Stage 1/2 app tokens and require coordination across runtimes; see
[setup guidance](../setup-linear.md#stage-3-confirmed-creation). The deferred
Stage 2 handset observation remains unproven. No live ticket acceptance criterion
was checked from fixtures. The operator approved the create-only slice for a
local commit on 2026-10-01 UTC with the proposed message above. Push and deployment
remain unapproved. Updates and comment creation remain
blocked, so the original full Stage 3 and Stage 4 goals are not complete.

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
