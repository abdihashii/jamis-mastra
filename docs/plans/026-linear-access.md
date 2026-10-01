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

## Next slice: verify the existing create-only delivery

Scope decision (2026-10-01 UTC), from local commit `70455dc`: the operator chose
**pause feature work for deployment and handset verification**. No further
implementation is authorized. The working tree was clean before this planning
update. A read-only check of JAM-64 and its comments confirmed that its progress
narrative still ends at Stage 2, says Stage 3 is unapproved, and has no Stage 3
progress comment. Only the credential/team acceptance criterion is checked.
No live ticket change, token request, scope transition, or mutation ran.

Strict stale-write guarantee retained: updates and comments remain blocked.
Relationships cannot be assumed safe without verified atomic preconditions for
all referenced issues. A final reread remains insufficient. Independent
create-only sequencing is a feasible future candidate because it references no
existing issue revision, but it is deferred by this decision. Additional create
metadata and the original Stage 4 are also deferred. ADR 0022 is unchanged.

Read-only deployment preparation (2026-10-01 UTC): VPS checkout is clean at
`3dbabd1`, an ancestor of `70455dc`; all four Compose services are running.
VPS `.env.prod` exists with mode `0600` and nonempty Linear client ID, client
secret, and team ID settings. Presence does not validate credentials or app/team
identity. No values were printed and no token was requested. The remote JAM-64
branch remains at `43bd483`, so the three locally approved implementation commits
must be pushed before branch-based deployment. Shared-app runtime inventory is
awaiting operator confirmation. No push or deployment ran.

The operator subsequently authorized the push on 2026-10-01 UTC. The JAM-64
remote branch now resolves to `70455dc3a899ee93713db711d4bfcd61782ed7e9`,
verified with `git ls-remote` after the successful push. This planning update
remains uncommitted and was not pushed. Deployment, scope transition, ticket
mutation, and live issue creation remain unauthorized.

The operator confirmed that the VPS is the only production copy of Jamis and
explicitly authorized deploying this branch. No local listener was observed on
port `4111` (not a complete inventory of arbitrary local processes). Deployment
via the existing `infra/deploy.sh` succeeded on 2026-10-01 UTC. The VPS checkout
was verified at `70455dc3a899ee93713db711d4bfcd61782ed7e9`; the app container
started at `2026-10-01T16:28:58.033929663Z`, was running with zero restarts,
and matched the newly built image. All four Compose services were running.
Read-only API health/auth checks returned 401 without authentication and 200
with the runtime token; no credential values were printed. Linear token/scope
smoke, handset reads/creation, ticket synchronization, and live issue mutations
have not run. No new local commit was made.

After explicit operator authorization, the production-checkout identity/read
smoke ran successfully on the VPS with `read,issues:create` on 2026-10-01 UTC.
It used Bun 1.3.14 with the checkout mounted read-only and `.env.prod` supplied
privately. Observed app user `7207c952-99d3-424c-abd8-d405facd0d5f` (`jamis`,
`app: true`) and pinned team `62db635f-aa68-484c-9458-f4d48b92236c` (`jamis`,
`JAM`), matching prior operator-confirmed identities. JAM-64 details returned
`ok`, `In Progress`, with explicit truncation/partial indication; comments and
attachments returned valid empty pages. Backlog and search returned `ok` with
partial-page flags and cursors. The synthetic foreign prefix was denied with
`outside_team`. The script exited zero, with no issue mutation, handset message,
credential value, or issue/comment body printed. This establishes the authorized
scope transition and VPS direct-read evidence, not handset behavior or a fresh
observation of installed-app team-access settings. Ticket checkboxes unchanged.

Operator-reported handset observation (2026-10-01 UTC): Jamis returned JAM-64's
correct title/link and `In Progress (started)` status, explicitly reported complete
empty comments and attachment lists, and noted that the issue description was
truncated/partial. This verifies the requested handset detail read; backlog and
ambiguity checks, confirmed creation, and production trace inspection remain
pending. No ticket mutation or new commit was made.

Operator-reported backlog handset observation (2026-10-01 UTC): Jamis returned
JAM-78, JAM-77, and JAM-76 with links and `Backlog` status, explicitly stating
that more results exist and this was the first paginated page. Together with the
detail read above, the deferred Stage 2 handset read demo is now observed.
Ambiguous-reference handling and the remaining write/trace checks are still
pending. Ticket acceptance checkboxes have not been changed.

Ambiguity handset check (2026-10-01 UTC): for “Read the Linear issue called
confirmed access”, Jamis selected JAM-64 and returned details without asking
for an exact identifier. This does not establish the planned clarification
behavior; the same session had already identified JAM-64, so prior conversational
resolution is a possible confounder. Tool-call evidence has not been inspected.
Do not mark ambiguous-reference acceptance complete from this response. A broader
title-reference check is pending; no fix or scope expansion is authorized.

Broader title-reference handset check (2026-10-01 UTC): for “Read the Linear
issue called Jamis”, the operator reported that Jamis refused to select among
multiple matches and requested an exact identifier or more specific title. This
observes clarification for an ambiguous reference. The reply claimed 22 matches;
that count and the underlying tool calls have not been independently verified.
The preceding session-resolved JAM-64 response remains recorded above. No issue
write has run; the next proposed smoke requires authorization for designated
test-issue content, starting with cancellation before any creation.

The operator authorized one live test issue titled
`JAM-64 handset confirmation smoke (2026-10-01)`, description
`Operator-authorized test of cancellation, confirmed creation, and repeated-confirmation protection.`,
status `Backlog`, with cancellation first, fresh confirmed creation second, and
repeated-confirmation protection afterward. The operator reported receipt of
the exact proposal, then sent `cancel` and reported no reply.

Read-only investigation (2026-10-01 UTC): designated proposal UUID
`9d12be19-72e6-467f-a550-67eefb202b74` is durably `canceled`, `notified: true`,
with no execution outcome and one later receipt. Direct Linear lookup of that
UUID reported no referenced issue. The exact later receipt was correlated via
its SHA-256 digest with channel trace `be028f7828c2553802e142225142764b`, whose
classification is `reply_delivery: failed`. Sendblue message history contains
the cancellation notification with `status: ERROR` and provider `error_code: 402`.
The provider's textual reason was not output and its cause has not yet been
established. Cancellation prevented creation; successful handset cancellation
notification is not established. The stored `notified` flag reflects cancellation
state handling, not successful handset delivery. Confirmed creation and replay
smokes are paused for this provider failure; no mutation retry, manual message
send, code change, new commit, or ticket update ran during investigation.

Cause established from the operator's Sendblue dashboard screenshot and
[official Security & Compliance documentation](https://docs.sendblue.com/security/#tcpa-compliance):
Sendblue has built-in opt-out detection for `cancel` (alongside `stop`,
`unsubscribe`, `opt out`, `revoke`, `end`, and `quit`) and opt-in via `start`.
The agent's guided instruction to send `cancel` therefore collided with provider
consent handling. The screenshot explicitly reports “recipient opted out”.
Restore consent by having the operator send `start`; do not override consent via
API. Future cancellation smokes should use `decline`, which is already accepted
by the application and is absent from the documented opt-out list. No product
code change is required to use that existing path. Opt-in restoration and resumed
smokes remain unobserved; do not infer successful delivery from durable cancellation.

Operator sent `start` and reported a handset reply saying it was not an explicit
Linear confirmation. Read-only Sendblue contact retrieval then verified
`contact.opt_out: false`; the designated old proposal remained `canceled` with
no execution outcome. Messaging consent is restored. The model's wording about
the old proposal does not make it actionable. Repeat the cancellation demo with
a fresh proposal and `decline` before proceeding to confirmed creation.

The operator reported a fresh exact proposal followed by `decline`, then receipt
of `Linear create proposal canceled.` on the handset. This observes successful
cancellation notification through the existing safe decline path. The operator
then requested clearer `confirm | decline` choices. A local copy-only change to
`formatLinearCreateProposal` now displays those choices explicitly, retaining
exact confirmation and next-message semantics. The existing native fixture's
prompt assertion was updated. This small correction is not committed, pushed,
or deployed; production still runs `70455dc`. A direct no-env formatting assertion,
typecheck, lint, and whitespace checks passed. The database-backed native fixture
was not rerun for this copy-only change; its updated assertion remains pending
that gate. Confirmed creation/repeated-confirmation and production trace leak
inspection remain pending.

At the operator's request to test again, the updated prompt passed the existing
native/durable channel fixture against fresh disposable loopback PostgreSQL.
The cancellation matrix now explicitly includes `decline` and asserts its
notification, with zero mutations. Native confirm/replay and uncertain-outcome
checks also passed. Full gate: **407 tests across 34 files, zero failures**,
including the parent wrapper for the **10 isolated native/durability checks**;
typecheck, lint, Studio build, and whitespace checks passed. Both database
variables pointed to the disposable local `jamis_sessions_test` instance. The
fixture container was stopped and automatically removed after verification.
This supersedes the earlier pending-native-gate note. The copy-only change and
verification notes remain uncommitted and undeployed; production remains at
`70455dc`. No new live mutation or handset message was sent by this test run.

The operator subsequently approved committing the clarification and deploying
the branch to production for another live test. Use proposed commit
`fix: clarify Linear confirmation choices`; retain the existing create-only
scopes and strict stale-write guarantee. Handset creation/replay evidence is
still pending and the ticket has not been mutated.

Clarification released as `7263704` (`fix: clarify Linear confirmation choices`)
on 2026-10-01 UTC. Commit pushed and branch deployed via the existing script.
VPS checkout verified clean at `726370444727f2d8c754381fda1b4e2bcc4735dc`;
app started at `2026-10-01T17:06:31.586027672Z`, running with zero restarts and
the newly built image. API checks returned 401 unauthenticated and 200
authenticated. Updated-prompt handset cancellation/create/replay checks are
next. These post-deployment observations remain local until another approved
evidence commit; no ticket mutation ran.

The operator observed the `confirm | decline` prompt on the handset at `7263704`
and requested cleaner formatting with fewer repeated instructions. A second local
copy-only revision removes enclosing field quotes (retaining JSON escaping inside
values), separates fields from the single next-reply instruction, and uses
`Create Linear issue in jamis?` as its header. Existing fixture assertions and
proposal-failure/rejection matchers were adjusted for that header. Direct
formatting/escaped-newline checks, typecheck, lint, the 10 isolated native/durable
checks, and whitespace checks passed; disposable PostgreSQL was removed. The
full repository gate has not been repeated for this second copy revision.
It is uncommitted and undeployed. The current live proposal was not confirmed or
canceled by the agent; production remains at `7263704`.

The operator authorized commit, push, and deployment of the cleaner prompt.
Final pre-release gate passed: **407 tests across 34 files, zero failures**,
including the native/durability wrapper; typecheck, lint, Studio build, and
whitespace checks passed. Both database variables targeted fresh disposable
loopback `jamis_sessions_test`; its container was removed. The local build's
initial sandbox temp-directory denial was resolved by rerunning with the required
access. No feature or confirmation-authority change is included. Proposed commit:
`fix: simplify Linear proposal wording`. Live checks resume after deployment.

Cleaner wording committed and pushed as `2a22400` on 2026-10-01 UTC. Initial
VPS image build failed resolving unchanged TypeScript 6.0.3; a single retry
succeeded without dependency changes and replaced the app. The operator also
reported deploying. Subsequent read-only checks verified checkout
`2a2240002748d1bcba627fb779d6d0b40ecbb71c`, app running with zero restarts,
and API statuses 401 unauthenticated/200 authenticated. The image tag differed
from the running container image at inspection, so the actual running `/app`
bundle was inspected separately and verified to contain the cleaner header and
single next-reply line. Handset prompt/create/replay checks remain next; these
post-release observations are local and no ticket update ran.

The operator observed the cleaner prompt on the handset, then reported the reply
“A bare confirmation here does not authorize creation. No issue was created.”
Read-only investigation found latest test proposal
`f2c8c1f0-acec-4b94-969a-e8782c17c72e` durably canceled, with no outcome and one
later receipt. Correlating that receipt to provider history established that its
trimmed content was a seven-character case variant of `confirm`, not exact
lowercase `confirm` and not a quoted word. Both source and latest messages were
present. The case-sensitive policy therefore canceled the proposal and allowed
the ordinary agent reply; this is not evidence of an exact-confirmation gate
failure. No mutation was claimed. Fresh proposal/lowercase confirmation and
replay checks remain pending; no policy relaxation or code change was made.

After `/new`, the operator sent the context-relative retry instruction (“same
description”) and reported no reply. `/new` was received and acknowledged; the
retry receipt was durably recorded at ordinal 16. Exact channel trace
`945cfc3af000156a9635378dbfebb2a9` finished without an outgoing reply, and no
active proposal existed. Correlated agent trace
`ec4eb706c9cc5a26e945477148a55466` shows `linearReadTool` followed by
`linearCreateProposalTool`. Create input had action `create` but an 8,000-character
description, exceeding the explicit 2,000-character limit. Its output was a
validation error; nevertheless the account agent claimed a proposal was posted,
and Jamis ended with no text. No proposal or mutation occurred. The agent's
context-relative test instruction was inappropriate after session reset; retry
with complete designated content. False posted-success reporting/silent handling
of tool validation errors is a verified defect to resolve separately before
calling the delivery complete. No code or live mutation was performed during
this read-only investigation.

### 4a. Retire the deployment and handset evidence gap (pending authorization)

**Goal:** Verify the already-committed bounded reads and confirmed single-create
path in the real operator DM before adding further feature scope.

**Critical files:** Existing `docs/setup-linear.md`, `scripts/linear-smoke.ts`,
deployment guidance/scripts, this plan, and ADR 0022. No code change is planned.
Use the committed Stage 3 implementation and its existing recovery contracts.

**Preparation:** Review the existing deployment procedure and identify every
runtime sharing the Linear app. Establish a coordinated transition from `read`
to `read,issues:create`, including rollback consequences: changing requested
scopes revokes existing app tokens. Verify VPS provisioning privately; local
provisioning is not evidence. Prepare exact commands and operator-designated
create content before requesting authorization. Do not run this checkout's
live smoke during preparation.

**Authorization boundaries:** Ticket synchronization is a live mutation and
needs separate authorization. Push, deployment, scope transition/token requests,
and an operator-designated issue creation demo are not authorized by the choice
to pause feature work. Prepare each concrete action before seeking its approval.
When the operator executes setup or smoke, give one command and expected output,
then wait for its result before the next step. Never print credential files.

**Verification order:**

1. Coordinate runtimes/scopes and privately verify required VPS configuration.
   After separate push/deployment authorization, deploy the approved commit.
   Record the deployed revision and safe health observations.
2. After scope-transition authorization, run the documented identity/team smoke
   on the deployed runtime, then `rtk bun run scripts/linear-smoke.ts --reads`.
   Expect the intended app/team identities and safe direct-tool read outcomes;
   retain the separate installed-app team-access observation.
3. Over the operator iMessage DM, retrieve JAM-64 and a backlog page; request
   comments/attachment metadata. Observe actual handset replies, partial-page
   labeling, and exact-identifier clarification for ambiguous requests.
4. With separately authorized operator-designated create content, cancel a
   proposal and inspect Linear for no creation. Request a fresh proposal, confirm
   it, and inspect the exact issue/team/status. Repeated confirmation must not
   create another issue. Exercise `/new` cancellation without implying that live
   restart/response-loss scenarios have been demonstrated.
5. Inspect safe production trace evidence and record only observed results.
   Preserve unchecked acceptance criteria for blocked writes and unobserved
   scenarios. Re-run the full repository gate defined above if code changes
   become necessary; any fix needs its own scope and commit sign-off.

**Demoable acceptance:** The deployed revision is recorded; direct reads pass;
actual handset reads and a separately authorized confirmed single-create are
observed with cancellation and repeated-confirmation checks. An API acceptance
status alone is not handset-delivery evidence. The full original write and
relationship acceptance criteria remain incomplete.

**Proposed evidence-only commit:** `docs: record Linear handset verification`

Stop now with this proposed slice. Do not commit, push, deploy, change live scopes,
or perform live mutations. Implementation fixtures and review results remain the
historical evidence recorded in Stage 3, not newly executed checks.

### Pending Stage 3 ticket synchronization (draft only)

For a future authorized ticket edit, preserve all acceptance checkboxes and
historical Stage 2 observations. Clarify that the Stage 2 statement about Stage 3
being unapproved described that earlier point in time, then append:

> Stage 3 progress (2026-10-01 UTC): The operator retained the strict stale-write
> guarantee and approved a create-only slice. Updates and comment creation remain
> blocked because the verified Linear contracts expose no atomic issue-revision
> precondition. Implemented durable, single-use creation proposals bound to the
> validated operator DM and active parent session, with exact next-message
> confirmation, cancellation, conservative uncertain outcomes, and credential-safe
> runtime authority. Committed locally as `70455dc`
> (`feat: gate Linear issue creation with durable text confirmation`).
>
> Final gate passed: 407 tests across 34 files, zero failures, plus 10 isolated
> native/durability fixture checks; typecheck, lint, Studio build, and whitespace
> checks passed against disposable loopback PostgreSQL with stubbed HTTP.
> Correctness/contracts/concurrency/channel, security, and Ponytail review passes
> were sequential, not independent reviewer subagents. The Sendblue acceptance
> finding was fixed and verified; no verified findings remain.
>
> No live create, scope transition, handset creation, push, or deployment ran.
> Stage 2 handset reads remain deferred. The original full Stage 3 and Stage 4
> remain incomplete. Existing acceptance checkboxes are unchanged; fixtures do
> not establish broad live or production acceptance. Next-slice scope is pending.

Re-read the ticket immediately before any future authorized edit. This draft is
not permission to update Linear and has not been posted.

## Completion

Record verified Linear contracts, each stage's test totals and demo observations, approved commit IDs, deployment authorization, and production smoke/trace inspection evidence. Link this plan from JAM-64 and mark acceptance criteria complete only after their corresponding checks. Do not include live credentials, raw tokens, or private issue content in these records.

## Proposal failure reporting correction (2026-10-01 UTC)

Authorized local correction from `2a22400`, separate from feature expansion.

1. **Goal:** Use runtime posting evidence for create-proposal responses, including
   native validation failures before tool execution. **Critical files:** Linear
   tool, Sendblue handler, account/Jamis instructions, existing native fixture.
   **Verification:** Native oversized description, denied/unavailable/rejected
   posting with lying account memo and empty/false-success parent text must
   produce one safe failure, no actionable proposal, and zero mutations. Valid
   posting must retain one exact proposal without redundant text. Run the full
   gate against disposable loopback PostgreSQL and review authority boundaries.
   **Proposed commit:** `fix: report Linear proposal failures from runtime evidence`.

Do not commit, push, deploy, update the ticket, or perform live mutations.
Strict stale-write restrictions and all confirmation checks remain mandatory.

API/recommendation verification: Firecrawl Developer retrieved Mastra's tool
reference and validation-error issue #22283; Firecrawl extracted the current
[createTool reference](https://mastra.ai/reference/tools/create-tool) and
[channel guide](https://mastra.ai/docs/channels). The tool reference supports
`{ type: 'text', value }` output mapping and says `onOutput` skips errors.
Installed 1.71.0 `Tool.execute` returns validation envelopes before the callback,
and its agent mapping applies `toModelOutput` to those results. The native
fixture verifies that installed behavior rather than assuming current docs
prove version-specific validation handling. Perplexity discovery plus Firecrawl
extraction of the [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
supports independent execution-side scope/approval validation, exact-action
binding, replay protection, and failing closed. No new API, dependency, approval
framework, write scope, or issue update/comment support was added.

The new native regression was run against original `2a22400` channel/tool code:
it failed with zero outgoing replies for the 8,000-character description,
reproducing the observed silence despite the account memo claiming posting.
The corrected native fixture passed the new failure matrix and valid-posted
check on its first isolated run; older matrix checks then hit their existing
15-second timeouts on this host. Matrix timeouts and the parent wrapper budget
were increased to accommodate the added native cases; complete gate pending.

Correction gate completed (2026-10-01 UTC): **407 tests across 34 files, zero
failures**, including the wrapper for all **12 isolated native/durability
checks**. Typecheck, lint, Studio build, and diff whitespace checks passed. Both
database variables targeted disposable loopback `jamis_sessions_test`; model,
Linear, and Sendblue traffic in the contract checks remained stubbed. Native
validation, denied agent identity, unavailable preparation, and rejected posting
each produced exactly one safe failure despite a false account memo and either
empty or false-success parent text. They left no actionable proposal and no
mutation, including after a subsequent `confirm`. Accepted posting retained
one exact proposal and suppressed redundant parent text. Existing cancellation,
case sensitivity, adjacency, parent-session binding, replay, rollover, and
uncertain-outcome checks also passed.

Correctness/integration and security-audit lanes were reviewed sequentially,
without independent subagents. No verified findings remain in the correction.
Runtime reporting flags are held only in the existing AsyncLocalStorage turn;
no model memo or serialized context grants posting or write authority. Durable
proposal claiming/execution, confirmation rules, input bounds, credential scopes,
and strict stale-write restrictions are unchanged. Prior plan observations were
preserved. This is local fixture evidence, not production/handset verification.

Proposed commit remains `fix: report Linear proposal failures from runtime evidence`.
All correction changes remain uncommitted. No push, deployment, ticket update,
live credential request, message send, or issue mutation was performed.

### Review correction: preserve other answers and native errors

Independent review found the reply proxy discarded unrelated answers and native
reauthentication notifications after any proposal attempt. Authorized fix:

1. **Goal:** Keep runtime-owned Linear proposal status while preserving other
   requested answers and native errors. **Critical files:** Sendblue handler,
   Jamis instructions, existing native fixture. **Verification:** Actual native
   issue-read evidence survives both accepted and denied create proposals; model
   proposal-status fields are ignored; model authentication failures retain their
   safe reauthentication notification; validation/no-reply and all durable
   authority regressions still pass. Run the full gate on disposable loopback
   PostgreSQL. **Proposed commit:** unchanged correction commit above.

After a proposal attempt, Jamis separates other answers into a small JSON
`otherAnswers` field. The channel parses that field and renders its strings,
while ignoring model proposal-status fields and unstructured acknowledgments.
Native generic/authentication error constants bypass this response boundary.
This is reply composition only, with no new mutation or confirmation authority.
The structured boundary avoids a prose keyword filter. Commit, push, deployment,
ticket updates, and live mutations remain prohibited. Verification pending.

Review correction verified (2026-10-01 UTC): **407 tests across 34 files, zero
failures**, including the wrapper for **14 isolated native/durable checks**.
Typecheck, lint, Studio build, and whitespace checks passed. Both database
variables targeted fresh disposable loopback `jamis_sessions_test`; provider
and model traffic remained stubbed. Mixed-request evidence now runs through
`linearReadTool` on the account child and native delegation, matching production
routing. Accepted and denied proposals both preserve the requested issue-read
answer, ignore the model's separate false proposal-status field, and perform
zero mutations. Native model authentication failures retain exactly one safe
reauthentication notification after accepted or failed proposals. Existing
validation, false-success/empty-text, exact-proposal, confirmation, cancellation,
replay, rollover, and uncertain-outcome checks passed unchanged.

Independent correctness and Mastra/contracts reviewers rechecked the correction
and found no verified introduced defects. The reply envelope is parsed in the
channel; it does not change Mastra structured-output APIs or write authority.
Jamis's envelope instruction explicitly preserves required research/weather
answer formatting inside separate answer strings. Native generic/authentication
error notifications pass through directly. All prior commit/live-operation
restrictions remain in force; no commit, push, deployment, ticket update, live
message send, or Linear mutation ran. Proposed commit remains
`fix: report Linear proposal failures from runtime evidence`.

The operator approved committing the verified correction on 2026-10-01 UTC
with “go and then we test.” Commit message:
`fix: report Linear proposal failures from runtime evidence`. Per the global
per-stage approval rule, push and production deployment require separate
confirmation; handset testing follows the verified production release.

The operator separately approved push and deployment on 2026-10-01 UTC.
Correction committed and pushed as `b19d03f042d85cf7d47523f0063ace15b372f731`
(`fix: report Linear proposal failures from runtime evidence`). Deployment via
the existing `infra/deploy.sh` succeeded; VPS checkout was clean at that exact
revision. App was running with zero restarts, started at
`2026-10-01T18:23:51.77869194Z`; all four Compose services were running. The
actual running `/app/mastra.mjs` verified the reply schema/parser, safe proposal
failure text, and native reauthentication-error bypass. API checks returned 401
without authentication and 200 with the runtime token; no token was printed.
Handset testing is next, beginning with `/new` and its acknowledgment. No issue
mutation or ticket update ran during release verification. These post-release
observations remain local and uncommitted.

Operator reported `/new` acknowledgment after `b19d03f` deployment, then sent
the full designated create content together with a JAM-64 status request. The
handset received one exact `Backlog` create proposal and a separate reply
reporting JAM-64 `In Progress` with its link. This observes the valid mixed-reply
path on production, not the validation-failure path. Read-only durable inspection
found exactly one active proposal `0168f636-274e-4c98-af51-89e6a4ccee07`, state
`pending`, no outcome, exact designated content, and source equal to the latest
recorded operator receipt. The active session matches and no conflicting time-zone proposal exists.
No issue mutation or ticket update was performed by this inspection.

The operator reported handset autocorrect changed the confirmation to uppercase
`Confirm`. Read-only inspection found proposal
`0168f636-274e-4c98-af51-89e6a4ccee07` durably `canceled` with no outcome.
The case-sensitive rule remained unchanged and this proposal did not execute.
A fresh full-content proposal is required before another lowercase confirmation.

Operator reported successful handset creation of JAM-80 on 2026-10-01 UTC.
Independent Linear read verified UUID `b7047bf6-28ac-4d1f-94ee-f504cdf2b5e1`,
exact designated title and description, `Backlog`, pinned `jamis` team
`62db635f-aa68-484c-9458-f4d48b92236c`, and creator Jamis app actor
`7207c952-99d3-424c-abd8-d405facd0d5f`. Creation timestamp:
`2026-10-01T18:33:10.360Z`. Durable outcome inspection is recorded separately.
Repeated-confirmation protection is the next handset observation, not yet proven
from this creation reply. No ticket update ran.

### Capitalization correction (2026-10-01 UTC)

The Operator explicitly requested accepting capitalized confirmation unless
Sendblue disallows it. Installed Sendblue 0.2.0 assigns incoming message text
from `raw.content` unchanged. Fresh Firecrawl extraction of
[Sendblue security documentation](https://docs.sendblue.com/security/#tcpa-compliance)
lists opt-out detection for `stop`, `unsubscribe`, `cancel`, `opt out`, `revoke`,
`end`, and `quit`, with opt-in via `start`; `confirm` is not listed. Previously
observed capitalized receipts were processed by the app, so the restriction was
the application equality check, not provider rejection.

1. **Goal:** Accept capitalization of the trimmed word `confirm` without
   relaxing any other confirmation/write gate. **Critical files:** Sendblue
   confirmation check, existing native fixture, setup guide, ADR 0022.
   **Verification:** Native `Confirm`, `CONFIRM`, mixed case, and surrounding
   whitespace execute once; replay does not repeat creation. Quoted/punctuated
   confirmation, other messages, provider adjacency, session, rollover, and
   uncertain-outcome checks remain enforced. Run the full gate with disposable
   loopback PostgreSQL. **Proposed commit:** `fix: accept case-insensitive Linear confirmation`.

Implementation is authorized; commit, push, and deployment of this new correction
await their separate approvals. Live production remains at `b19d03f`.

JAM-80 durable outcome verified: proposal/issue UUID
`b7047bf6-28ac-4d1f-94ee-f504cdf2b5e1` is `succeeded`, notification recorded,
outcome identifier `JAM-80`. After the operator repeated lowercase `confirm`,
the handset replied “There is no pending action to confirm.” Read-only durable
inspection found the same succeeded outcome, two later receipts after proposal
source (confirmation and replay), and zero active proposals in that DM. A
complete Linear listing of the pinned team with creation timestamps since
`2026-10-01T18:30:00.000Z`, including archived issues, returned only JAM-80
(`hasNextPage: false`). This observes one exact live creation and replay
protection at `b19d03f`. It does not establish live capitalization support or
production validation-failure/leak-audit acceptance. Ticket unchanged.

Capitalization gate completed (2026-10-01 UTC): **407 tests across 34 files,
zero failures**, including the wrapper for **15 isolated native/durable checks**.
Typecheck, lint, Studio build, and whitespace checks passed. Both database URLs
pointed to disposable loopback `jamis_sessions_test`; provider/model traffic
remained stubbed. The initial test attempt started before PostgreSQL finished
initializing and failed with connection errors; after readiness verification,
the full gate rerun passed. Native capitalization/whitespace variants each
executed once and remained single-use; quoted/punctuated/non-confirm messages,
adjacency/session checks, rollover, and uncertain outcomes remained protected.
Independent security review found no introduced vulnerabilities and verified
the unchanged authority boundaries. The disposable database was removed after
the gate. Code remains local and uncommitted; production remains `b19d03f`.
Proposed commit: `fix: accept case-insensitive Linear confirmation`.

The operator approved both the capitalization commit and its push/deployment on
2026-10-01 UTC with “go, we'll test again,” after separate commit and release
questions identified the exact correction. Commit message:
`fix: accept case-insensitive Linear confirmation`. Follow release verification
with one handset step at a time. Ticket updates remain unauthorized.
