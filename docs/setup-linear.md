# Jamis Linear app setup

Stages 1 and 2 of [plan 026](plans/026-linear-access.md) authenticate the app and
expose bounded issue reads in the pinned `jamis` team. The operator-approved
Stage 3 slice adds durable confirmed creation only. Updates and comment creation
remain unavailable because Linear exposes no atomic issue-revision precondition.

## Verified contracts (2026-10-01 UTC)

- [Linear OAuth](https://linear.app/developers/oauth-2-0-authentication#client-credentials-tokens):
  enable client credentials tokens on the OAuth app. POST URL-encoded
  `grant_type=client_credentials`, `client_id`, `client_secret`, and comma-separated
  `scope` to `https://api.linear.app/oauth/token`. The token is an **app actor**,
  valid for 30 days (`expires_in`, example 2591999), with no refresh token.
  Request a token for each runtime, never persist it. On 401, obtain a new token.
- Stage 1 requests only `read`, and validates the returned scope. Later issue
  updates need `write`; create/comment-only integrations can use `issues:create`
  and `comments:create`. No admin or native-agent scope is needed. Changing
  client-credentials scopes revokes existing app tokens, so coordinate the later
  scope change across runtimes.
- The Stage 3 create-only client now requests **`read,issues:create`** uniformly
  for reads, proposals, and execution. It rejects other scopes, including `write`,
  `comments:create`, admin, and native-agent scopes. All runtimes using this app
  must agree on this set: running a Stage 1/2 checkout that requests only `read`
  would revoke the new tokens again. Coordinate the scope transition before
  running any live smoke from this checkout. No live scope transition has been
  performed as part of implementation verification.
- [App authentication](https://linear.app/developers/agents#installation): `viewer.id`
  identifies the app user within the workspace. The [published Linear schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
  defines `viewer: User!`, `User.app: Boolean!`, `User.name: String!`, and
  `team(id: String!): Team!` with `id`, `name`, and `key`. The client requires an
  app actor named `Jamis` (case insensitive), and the exact configured team UUID
  with the name `jamis`. The smoke reports IDs for operator comparison, not just
  a successful token request. Name is a sanity check, not a unique app ID pin.
- Client credentials initially grant access to **all public teams**. Narrow it
  through the [app details page](https://linear.app/settings/applications/) after
  first token generation. Workspace admins can change or revoke access anytime.
  A successful team query does not prove other teams are inaccessible. Inspect
  the configured team access in Linear as a separate smoke observation.
- Rotating the client secret immediately invalidates client-credentials tokens.

## Provision on each runtime

1. In the intended workspace, create a distinct OAuth app named **Jamis** in
   Settings, API, Applications. Enable **client credentials tokens**. Do not
   enable webhooks, agent session events, mention, assignment, or admin scopes.
   This grant needs no redirect listener or operator OAuth token.
2. Privately put the app's client ID and secret into local `.env` or the VPS
   `.env.prod`. Use the `jamis` team's UUID (team settings, Copy team ID), not
   its `JAM` issue prefix. Keep the env file mode 0600. Never paste secrets or
   tokens into chat, commit them, or use a command that prints the file.

   ```env
   LINEAR_CLIENT_ID=...
   LINEAR_CLIENT_SECRET=...
   LINEAR_TEAM_ID=...
   ```

3. Run the identity/team smoke locally:

   ```bash
   rtk bun run scripts/linear-smoke.ts
   ```

   Expect only JSON with `viewer` (`id`, `name: Jamis`, `app: true`) and `team`
   (`id` matching the configured UUID, `name: jamis`, `key: JAM`). Check the
   viewer ID/name against the intended Jamis app in Linear. No token is printed.
   Default smoke authenticates and reads metadata; it never writes an issue.
4. In Linear's installed app details, restrict Jamis team access to **jamis
   only**, then rerun the smoke and inspect that the selection remains restricted.
   Record both observations in plan 026. Client-side ID/name enforcement remains
   required even after this server-side restriction.

Production already uses `env_file: .env.prod`, so no Compose change is needed.
Provisioning secrets does not authorize deployment. After a separately approved
deployment, run the smoke from the checkout with its installed dependencies and
production env loaded privately. The script imports Zod and needs `node_modules`;
the dependency-free Google login container recipe does not apply.

## Recovery

The client keeps tokens only in a private runtime closure, renews 60 seconds
before expiry, and bounds each HTTP request/body read to 10 seconds. A 401/403
clears the cached token; the next call requests a new app token. There is no
operator-token fallback, token file, raw upstream error log, or trace wrapper.

Failures print a fixed category: `configuration`, `authentication`, `identity`,
`team`, `response`, `timeout`, or `unavailable`. Check missing env/UUIDs first;
for authentication, check client-credentials enablement, secret rotation, and
app access in Linear. For identity/team, check the correct app, names, team UUID,
and selected team access. Rerun the smoke after correction. Never log request
bodies, Authorization headers, response bodies, or fetch/Zod error objects.

If credentials are exposed, rotate the client secret in Linear, update each
on-box env file privately, and restart the affected runtime only after separate
authorization. Do not recover by storing a personal token or copied app token.

## Stage 2 read surface and smoke

`personal-accounts-agent` owns `linearReadTool` alongside Gmail and Calendar.
Jamis delegates account requests with isolated account history. Linear results
are untrusted evidence; no issue write or attachment file transfer is available.

The tool supports `list`, `search`, `issue`, `comments`, and `attachments`.
List/search filters are exact state name, state type (`triage`, `backlog`,
`unstarted`, `started`, `completed`, `canceled`), priority 0 through 4 (0 means
none), and assignee UUID. Search takes a term of at most 200 characters. It uses
`searchIssues` with `filter.team.id.eq`; the API's `teamId` argument merely boosts
ranking and cannot enforce access. Deprecated `issueSearch` is not used.

Pages default to 10 items, maximum 20. `partial` means the result is incomplete,
whether due to more pages or truncated text. `nextCursor` is present only when
more pages exist; pass it as `cursor` with the same action/reference/filters.
No hidden page traversal occurs. Descriptions are capped at 8000 characters and
comment bodies at 4000, with explicit `truncated` flags. Title/URL/page shapes
are validated; malformed results fail safely rather than inventing missing data.

Details/comments/attachments take an identifier such as `JAM-64` or an issue
UUID. Foreign team prefixes are denied. Resolution is filtered to the pinned
team; no match means not found or inaccessible, never permission to fetch an
unverified target. A title reference returns candidates and requires the operator
to choose an exact identifier, even when one candidate is shown. Ambiguous results
have no continuation cursor; use `search` with `query` to expand candidate pages.
Every returned
issue is checked for team membership; a detail read rechecks membership and every
nested comment/attachment is checked against its requested issue and team.

Direct-tool read smoke (prints metadata/counts only, no issue or comment text):

```bash
rtk bun run scripts/linear-smoke.ts --reads
```

Expected: JAM-64 details/comments/attachments return `ok`; backlog/search return
`ok` and label pagination; a synthetic `OUTSIDE-1` prefix returns `denied` without
an issue read. Zero comments/attachments is a valid empty page. This prefix check
does not prove server-side access restrictions; retain the installed-app check.

Read contracts verified on 2026-10-01 UTC against the [published schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql),
[filtering](https://linear.app/developers/filtering), and
[pagination](https://linear.app/developers/pagination): `issues(filter:)`,
`searchIssues(term:, filter:)`, `issue(id:)`, nested `comments`/`attachments`,
and `pageInfo.hasNextPage/endCursor` with `first`/`after`. Only attachment title
and link metadata are returned. No file URL is fetched.

## Stage 3 confirmed creation

`linearCreateProposalTool` accepts only `action: create`, a title (1 through 200
characters), description (at most 2000 characters), and an optional exact state
name. Omission resolves the team's default workflow state. Missing, ambiguous,
or foreign states are refused. The proposal displays the exact title, description,
and resolved status; execution explicitly pins the configured team and state IDs.
Other fields, issue updates, comment creation, relationships, and sequences are
not exposed. Linear's published update/comment inputs have no issue revision
precondition, so these operations remain blocked under the retained strict
stale-write guarantee; a non-atomic reread is not substituted.

Only the validated operator Sendblue DM can propose creation. Runtime authority
follows native account delegation through AsyncLocalStorage, outside serialized
request-context entries and trace exports. The proposal records its source message,
external DM, actual parent memory session, operation, and execution state in
Postgres. A shared single-use channel capability arbitrates Linear and time-zone
proposals. Studio, forged tool context, other senders, groups, and other channels
cannot authorize creation.

Only the immediately following, trimmed, case-sensitive `confirm` executes.
Durable receipt order and provider-history adjacency both have to agree; equal
provider timestamps do not prevent confirmation. Every other new operator message
cancels, including login and `/new`. Duplicate deliveries do not consume newer
proposals; replayed `/new` does not clear them. Session rollover cancels pending
creation before creating the new session.

Proposal posting occurs inside the transaction. The adapter validates a nonempty
matching message handle and `QUEUED`, `SENT`, or `DELIVERED` status before Chat SDK
discards the raw response. `ERROR`, missing/malformed acceptance, and thrown posts
roll back the proposal. These statuses establish API acceptance, not handset
delivery. A lost commit acknowledgement alone cannot authorize execution; a later
confirmation must read the committed proposal and reverify adjacency/session
before claiming it. The execution claim commits before
any mutation is sent. Preflight revalidates app/team and the selected workflow
state, with at most one retry before sending. Every possibly sent mutation failure
is treated conservatively as uncertain, including partial GraphQL errors and lost
or malformed responses. There is no automatic mutation retry. A caller-provided
UUID identifies the requested create for inspection; it is not assumed to prove
remote idempotency.

A recovered claim is reported as uncertain and never executed again. Stored
success survives failed result posting; notification recovery reports that success
without another mutation. Inspect an uncertain issue UUID in Linear before a new
attempt. `/new` cannot clear or resend a claim or unreported outcome. Status
notifications may be repeated after a lost posting acknowledgement; issue creation
is single-use. The existing production channel-render-context trace sanitizer is
reused and exercised by the native fixture.

Run the local protocol smoke with disposable loopback PostgreSQL (both database
variables set to `jamis_sessions_test`), using stubbed Linear/Sendblue traffic:

```bash
rtk bun --no-env-file test src/mastra/channels/sendblue-linear.test.ts
```

This is not a live Linear mutation or handset demo. The operator-designated live
creation demo and deferred Stage 2 handset reads remain unobserved, pending a
coordinated scope transition and separately authorized deployment.
