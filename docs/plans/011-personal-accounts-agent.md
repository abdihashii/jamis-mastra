# 011: Personal-accounts agent with read-only Gmail

Status: **Planned.**

Linear: [JAM-50](https://linear.app/abdirahman-haji/issue/JAM-50/add-personal-accounts-agent-with-read-only-gmail-v1).

Jamis gains read-only access to the operator's Gmail through a new internal subagent, `personal-accounts-agent`, per [ADR 0015](../adrs/0015-personal-accounts-agent.md). One tool, `gmail-search`, runs Gmail search-box queries over the REST API with plain `fetch`; the credential is a 0600 JSON file in `data/`, captured headless by a `login:google` script. No googleapis dependency, no third-party integration platform.

## Decisions

Resolved in a grill-with-docs session on 2026-09-04 against ADR 0015 and the research basis below.

- **Composio rejected** (recorded in ADR 0015's alternatives). Self-serve plans store captured OAuth tokens in Composio's cloud even with a bring-your-own app; on-prem needs their self-hosted runtime. A third party in the credential path contradicts ADR 0014's stance for one operator and one restricted scope.
- **Client id and secret are env vars.** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`, `.env.prod`, and both templates, read once at module load via `requireEnv` (a missing value is a hard failure at boot, same as the other keys). Desktop-client secrets are documented as non-confidential, but they stay out of code and form the `GOOGLE_*` scan surface from the JAM-50 acceptance criteria. Tokens never enter env.
- **`gmail-search` is one deep tool.** Input: `query` (raw Gmail search syntax, required) and `maxResults` (optional, default 5, hard cap 20). The tool runs `users.messages.list`, then `users.messages.get(format=full)` per hit, decodes the first `text/plain` body part from base64url, and returns per message: `subject`, `from`, `date` (ISO 8601 UTC from `internalDate`), `snippet`, and `body` truncated at 4000 characters. Messages with no plain-text part return the snippet only (HTML-to-text stripping is a known limit, not v1). Yahoo-style MIME walking stays inside the tool; the subagent receives summarization-ready text.
- **Subagent model is Fireworks `deepseek-v4-flash`.** Bounded formatting/summarization of tool output, weather-agent precedent. PII flows to Fireworks the same way weather location text does today; quota-bearing codex inference is not spent on mechanical steps.
- **`login:google` binds a fixed default port with an env override.** Listener on `127.0.0.1:53682` (`GOOGLE_LOGIN_PORT` overrides) so the operator's `ssh -L 53682:127.0.0.1:53682 vps` tunnel command is stable across logins. Google permits any loopback port for Desktop clients, so there is nothing to register per port.
- **Layout mirrors the Codex credential work.** `src/lib/google-oauth.ts` (credential load/save/refresh and token exchange, `node:` builtins + `fetch` only — the login script runs via `oven/bun` on the VPS with no `node_modules`), `src/mastra/tools/gmail-search.ts`, `src/mastra/agents/personal-accounts-agent.ts`, `scripts/google-login.ts`, and a `login:google` `bun --bun` package.json script. Unit tests in `src/lib/__tests__/google-oauth.test.ts` and `src/mastra/tools/__tests__/gmail-search.test.ts` with mocked fetch, following `gateways/__tests__/openai-codex.test.ts`.
- **Delegation to personal-accounts-agent carries only the task.** `jamis.ts` `messageFilter` extends from research-agent-only to both `research-agent` and `personal-accounts-agent` (empty history), per ADR 0015's stated precedent. Interpretation of conversational references stays with Jamis (strongest model); the subagent receives a precise search task. Jamis's instructions gain one routing line: personal-account requests (Gmail today, Calendar later) delegate to `personal-accounts-agent`, and Jamis never narrates routing.
- **Auth failures surface one generic string.** `src/lib/google-oauth.ts` throws `Authentication failed. The error was logged.` (mirroring ADR 0014's `MODEL_AUTH_FAILURE`) whenever the credential is missing or a refresh fails with `invalid_grant`; recovery detail (re-run `login:google`) goes only to server logs. The subagent relays that text verbatim for auth errors instead of inventing recovery steps; rate-limit/server errors follow the weather-agent relay pattern ("Gmail is having trouble, try again later").
- **Silent refresh on expiry.** Access tokens (~1 hour) refresh from the stored refresh token before use, with a 60-second clock-skew margin and a single in-process refresh promise (one agent process runs at a time, `# ponytail:` comment as in the Codex module). If Google's refresh response carries a rotated `refresh_token`, persist it before use; otherwise keep the stored one.
- **Dev and prod share one OAuth client.** One Google Cloud project, one Desktop client, one consent screen in Production status. Dev login runs `login:google` on the Mac (browser on loopback, no tunnel); prod login runs it on the VPS through the tunnel. Both write the same-shaped `data/google-oauth.json` in their respective environments; the client id/secret env vars carry the same values in both.

## Research basis

| Fact | Source | Consequence |
| :--- | :--- | :--- |
| Desktop (installed-app) OAuth clients use a loopback redirect `http://127.0.0.1:port`; the docs say to start an HTTP listener on a random available port, and the loopback option is deprecated only for Android/iOS/Chrome client types, not Desktop | `developers.google.com/identity/protocols/oauth2/native-app` (scraped) | `login:google` can bind any port; a fixed default + override is legitimate |
| Offline access (a refresh token) is requested with `access_type=offline` on the auth URL; `prompt=consent` re-shows consent and re-issues a refresh token on re-login | `developers.google.com/identity/protocols/oauth2/web-server` (scraped) | Both params go into the login script's auth URL |
| `client_secret` is documented "Optional" at the code exchange for installed apps, but Google provisions one for Desktop clients and secretless exchanges are reported to fail with `invalid_request: client_secret is missing` | same native-app doc + developer reports (web search) | Always send the issued secret |
| Refresh tokens die on: External+Testing publishing status (7 days, unless only userinfo scopes), user password change with Gmail scopes, revocation, 6-month disuse, and the 100-live-tokens-per-client cap | `developers.google.com/identity/protocols/oauth2` (scraped) | Consent screen publishes to Production; the password-change caveat and re-login recovery go into setup docs and ADR 0015's known limits |
| Restricted scopes (`gmail.readonly`) need no verification under the personal-use exception: a single user known to the developer advances through the unverified-app screen; a user cap applies; Production publishing lifts the 7-day refresh-token expiry | `developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification` (scraped) | No verification submission, no security assessment; unverified warning accepted for one operator |
| `users.messages.list` accepts the full Gmail search-box syntax in `q`, `maxResults` defaults to 100 and caps at 500; `q` and `format=full` are unavailable under the weaker `gmail.metadata` scope | `developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/{list,get}` (scraped) + v1 discovery doc | `gmail.readonly` is the minimal sufficient scope; the tool passes `q` verbatim |
| `format=full` parses the body into `payload.parts` (base64url); `format=metadata` returns headers only | Gmail v1 discovery document | The tool decodes plain-text parts itself; no client library needed |
| `mastra api tool execute <id> <json>` exists on the installed CLI (mastra 1.25.0) with `--url` and repeatable `--header`; server-side tool lookup walks registered agents' `listTools()`, and plan 007's verified acceptance showed subagent tools (research-agent's Firecrawl tools) in `tool list` | local CLI `--help`; `@mastra/server` `findToolInAgents`; plan 007 | The JAM-50 acceptance command works without registering anything on the root Mastra instance; verified live in Stage 2 and Stage 4 smokes regardless |
| Composio self-serve captures OAuth tokens through its backend callback and stores them in Composio's cloud; credential-on-prem requires their self-hosted platform | composio.dev buyer's guide + nango.dev comparison (Firecrawl search) | Alternative rejected; ADR 0015 amended |

## Public interface changes

- `package.json` gains `"login:google": "bun run --bun scripts/google-login.ts"`. No new runtime dependencies.
- `.env.example` and `.env.prod.example` gain `GOOGLE_CLIENT_ID=` and `GOOGLE_CLIENT_SECRET=` with a one-line provenance comment. Because `requireEnv` fails at boot, Stage 3 adds the values to the real `.env` and `.env.prod` before Stage 4 deploys.
- New gitignored `data/google-oauth.json` (`data/` is already ignored and already bind-mounted into the prod container): access token, refresh token, `expiresAt`, granted `scope`, `tokenType`.
- New `docs/setup-gmail.md`: consent screen configuration (External, Production, unverified warning, user cap), Desktop client creation, env vars, `login:google` locally vs over `ssh -L`, and the password-change-kills-the-token caveat.
- `mastra api agent list` still returns only `jamis` (the subagent is never on the root Mastra instance). `mastra api tool list` gains `gmail-search`.
- No Dockerfile, compose, Cloudflare, or channel changes.

## Stage 1: Google OAuth credential plumbing

**Goal.** Capture and refresh a real Google credential with nothing in the agent's import graph.

**Critical files.** New `src/lib/google-oauth.ts`, new `scripts/google-login.ts`, new `src/lib/__tests__/google-oauth.test.ts`, `package.json`, `tsconfig.json` (add `scripts/**/*` to `include`, same as plan 009), `.env.example`, `.env.prod.example`.

- `google-oauth.ts` mirrors `openai-codex-auth.ts`'s shape: the credential type, atomic temp-plus-rename `0600` save, cwd-then-walk-up-6-path resolver (the `mastra dev` bundler cwd quirk), `isExpiring` with skew, single-flight `refreshCredential` persisting any rotated refresh token before use, `getUsableCredential` throwing the generic auth string, and the PKCE/S256 + token-exchange helpers. Google specifics: scope check that the granted scopes are exactly `gmail.readonly`, `state` CSRF verification input returned to the caller. Never log token values; log field names and statuses only.
- `scripts/google-login.ts` starts the loopback listener, prints the consent URL (never a token), waits for one callback, verifies `state`, exchanges the code, saves the credential, and serves a close-the-browser HTML page on success or denial.
- Tests cover: save/load round-trip and `0600` mode, missing-corrupt file handling, expired-token refresh against mocked token endpoints (success, `invalid_grant` → generic error, rotation persisted), scope-mismatch rejection.
- `.env` templates gain the two `GOOGLE_*` lines.

**Verify.**

1. `bun install --frozen-lockfile` (no change), `bun test`, `bun run typecheck`, `bun run lint` all pass.
2. Operator-run: real `pnpm run login:google` locally against the operator's Google account writes `data/google-oauth.json` with `0600` and scope `gmail.readonly`; deleting the file and rerunning re-captures it (proves `prompt=consent` re-issues the refresh token).

**Proposed commit.** `feat: add Google OAuth credential plumbing and login:google`

## Stage 2: gmail-search tool and personal-accounts-agent

**Goal.** Read-only Gmail reachable through the new subagent, verified via the API CLI against local dev.

**Critical files.** New `src/mastra/tools/gmail-search.ts`, new `src/mastra/agents/personal-accounts-agent.ts`, new `src/mastra/tools/__tests__/gmail-search.test.ts`. Neither is imported by `jamis.ts` yet (registration lands in Stage 3, keeping this diff mechanical).

- `gmail-search`: `requireEnv` reads the client pair at load; `users.messages.list?q&maxResults` then per-id `users.messages.get?format=full`; header extraction (`Subject`, `From`, `internalDate`→ISO UTC); base64url decode of the first `text/plain` part (single-part or multipart); 4000-char body truncation; snippet-only fallback. Error classes weather-style: 401 after one silent-refresh retry → the generic auth error; 429 → rate-limited; 5xx/network → service trouble; shape surprises → unusable data.
- `personal-accounts-agent`: flash model, weather-style instructions (answer with subject/sender/date and a summary; auth-error and service-error relay rules from Decisions), `tools: { gmailSearchTool }`. Not on the root Mastra instance.
- Tests mock fetch for list+get (happy path incl. multipart, truncation, no-plain-text fallback, query validation) and credential failure propagation (generic string, no token material in any thrown error).

**Verify.**

1. `bun test`, typecheck, lint.
2. With the Stage-1 credential present and `pnpm dev` running: `bun run --bun mastra api --timeout 60000 --url http://127.0.0.1:4111 --header 'Authorization: Bearer <API_TOKEN>' tool list` includes `gmail-search`, and `tool execute gmail-search '{"query":"is:unread"}'` returns the operator's real unread mail.
3. Repeat the execute with the credential file temporarily moved aside and confirm the response carries only the generic auth text.

**Proposed commit.** `feat: add gmail-search tool and personal-accounts-agent`

## Stage 3: Jamis routing and setup docs

**Goal.** Jamis delegates Gmail requests; setup is reproducible from docs alone.

**Critical files.** `src/mastra/agents/jamis.ts`, `docs/setup-gmail.md`.

- `jamis.ts`: `agents: { weatherAgent, researchAgent, personalAccountsAgent }`; instructions gain the personal-accounts routing line (Gmail requested → delegate, only the task; relay auth failures with the generic text; never offer email actions it does not have); `messageFilter` strips history for both `research-agent` and `personal-accounts-agent`.
- `docs/setup-gmail.md`: full manual path — Google Cloud project, consent screen (External; publish to Production; advance through the unverified warning; user cap), Desktop OAuth client, placing `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` into `.env` and the VPS `.env.prod`, `pnpm run login:google` locally, and on the VPS: `ssh -L 53682:127.0.0.1:53682 vps` plus the `oven/bun` script invocation from plan 009's container pattern. Password-change/revocation/disuse caveats from the research table, with re-login as recovery.

**Verify.**

1. `bun test`, typecheck, lint.
2. Local `mastra dev`: text-style delegation against the local server — a Gmail ask routes to `personal-accounts-agent` (trace shows `agent-personalAccountsAgent` and the `gmail-search` span), and a weather ask still routes to weather-agent unchanged.
3. Delete the local credential, repeat the Gmail ask, confirm the channel-visible text is only the generic auth line.

**Proposed commit.** `feat: route personal-account requests through Jamis`

## Stage 4: deploy and live acceptance

**Goal.** Every JAM-50 acceptance criterion holds against production.

**Verify (operator-driven, per AGENTS.md step-by-step rhythm).**

1. `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` into the VPS `.env.prod`; deploy with `infra/deploy.sh`; `mastra api agent list` over the tailnet still returns only `jamis`.
2. `ssh -L` login on the VPS against prod: `data/google-oauth.json` lands `0600` inside the container volume; `git check-ignore data/google-oauth.json` passes; granted scope string is exactly `https://www.googleapis.com/auth/gmail.readonly`.
3. `npx mastra api --url https://<tailnet-host> --header 'Authorization: Bearer <API_TOKEN>' tool execute gmail-search '{"query":"is:unread"}'` returns real unread mail.
4. iMessage: "what's my latest unread email?" answers with subject/sender/date and a body summary via Jamis → personal-accounts-agent (trace confirms the delegation chain).
5. Silent refresh: edit the stored `expiresAt` into the past, re-ask; the reply succeeds and the file is rewritten with a new access token.
6. Dead credential: move the file aside, re-ask; only the generic auth text reaches the channel, and server logs name `login:google` recovery.
7. Post-deploy scan (ADR 0013 pattern): query ClickHouse span attributes/inputs/outputs and Postgres messages for the `GOOGLE_CLIENT_SECRET` value, the access/refresh token values, and `ya29.` — zero rows; then delete the temporary dead-credential test messages. Restore the real credential.
8. Close JAM-50 with evidence links.

**Proposed commit.** None unless scans surface a fix; stage ends with the deploy and ticket closure, per prior plans.

## Known limits

- HTML-only mail returns snippet-only (no tag-stripping in v1).
- Bodies are truncated at 4000 characters in the tool result; Postgres retains the full record per ADR 0015's accepted retention posture.
- One refresh per account assumption: prod and dev each hold a credential; the 100-live-token-per-client cap is far away.
- Google's unverified-app posture can change; reversal is deleting the OAuth client and reverting these commits.
