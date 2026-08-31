# 009: Jamis model auth through the Codex subscription

Status: **Planned 2026-08-31 UTC.**

Planned from `main` at `d7a8c89`.

Jamis's OpenAI models (`jamis` and `researchAgent`, both `gpt-5.6-terra` at `max` reasoning effort) will authenticate through the operator's ChatGPT/Codex subscription using a custom Mastra model gateway. Subscription-only: no OpenAI API key in any environment, and a missing or dead credential is a hard failure until re-login. Prove the OAuth device flow and the undocumented codex protocol in standalone scripts before any agent depends on them.

The durable architectural reasoning is in [ADR 0014](../adrs/0014-openai-codex-model-auth.md).

## Decisions

- **Add a custom `openai-codex` gateway.** Register `gateways: { 'openai-codex': gateway }` on the Mastra instance and change both agents' model strings to `openai-codex/gpt-5.6-terra`. The gateway id is the namespace; bare `openai/*` ids keep their existing models.dev + env-key path, so weather and observational-memory models are untouched.
- **No API-key fallback, by operator choice.** No OpenAI API key in `.env`s at all. Prefix matching in `@mastra/core@1.61.0`'s `GatewayManager` claims `openai-codex/*` unconditionally once the gateway is registered (models.dev has no `openai-codex` provider, so the id cannot fall through), so the gateway owns the entire auth story for those ids: with a usable credential it serves the subscription; without one, model resolution throws a clear re-login error naming `scripts/openai-codex-login.ts`.
- **Fail loud on a dead credential.** If the credential exists but the request-time refresh fails, generation errors and the operator sees it through the existing channel error path. There is no alternate route to fail over to; recovery is always re-login.
- **Device flow only.** Headless PKCE against the Codex public OAuth client, built for SSH use; skip the localhost browser callback. The login script prints only the verification URL and user code, never a token.
- **Persist refresh-token rotation immediately, and respect the server's refresh window.** Access tokens live ~10 days (server-issued `expires_in`, observed 864000) and refresh tokens rotate: every refresh writes the new pair to disk (temp file plus rename, `0600`) before the access token is used, or a restart breaks auth. The token endpoint also declares `earliest_refresh_at`: refreshing before that window returns `401 refresh_token_invalidated` and kills the credential (verified live on 2026-08-31; the still-live access grant kept working). The module therefore refuses to refresh before the window. Refresh is serialized by one in-process in-flight promise — a Jamis turn and its research delegation can race a single expiry window. Assume a 60-second clock-skew margin on expiry. `# ponytail: in-process refresh lock, fine for one agent process`
- **One new dependency, not two.** Add `@ai-sdk/openai` (exact `3.0.88`, the version Mastra Code pairs with this core generation; change it only if resolution against `@mastra/core@1.61.0`'s vendored AI SDK line fails typecheck/build, and record that here). Do not add `ai`: the protocol body rules run inside the gateway's custom `fetch`, so `wrapLanguageModel` middleware is unnecessary weight.
- **Store the credential on disk, not in env.** `data/openai-codex-auth.json`, resolved relative to the working directory — the repo root in dev, `/app` in prod, where a `./data:/app/data` bind mount lands it. Same relative path both places, no env var. The file holds access token, refresh token, expiry, and account id with `0600` permissions. The agent process never receives the refresh token through environment variables.
- **Keep selection in code.** Model ids, instructions, and the effort setting remain ordinary reviewed code, not environment variables. Weather delegation and the Fireworks observational-memory model are untouched.
- **Never log credentials.** The base `serializeForSpan()` exposes only gateway id and name; do not override it with credential state. Audit every script for console output that could print a token. `SensitiveDataFilter` stays configured.

## Research basis

Framework facts were verified against `@mastra/core@1.61.0` in `node_modules`; protocol facts come from Mastra Code's Codex OAuth implementation.

| Fact | Consequence |
| :--- | :--- |
| `new Mastra({ gateways })` accepts custom gateways (Mastra constructor, ~line 249); `MastraModelGateway` is an abstract class exported from `@mastra/core/llm` with required `id`, `name`, `fetchProviders()`, `buildUrl()`, `getApiKey()`, `resolveLanguageModel()` | Subclass the abstract class; it is the intended extension point and needs no core change |
| `GatewayManager` selects a gateway by exact prefix match, then consults `handlesModel` (for unprefixed ids), then falls back to models.dev; auth resolution calls `resolveAuth()` before `getApiKey()` | Prefix claiming is unconditional, so the gateway owns all auth for `openai-codex/*` ids |
| `GatewayAuthResult` carries `apiKey`, `bearerToken`, and `headers`; gateways resolve to AI SDK `LanguageModelV2/V3/V4` | `resolveAuth()` returns the access token, account-id header, and originator; `resolveLanguageModel()` returns an `@ai-sdk/openai` Responses model |
| Base `serializeForSpan()` exposes only id and name | Credentials do not leak into tracing spans by default |
| Codex public client: issuer `https://auth.openai.com`, PKCE, `openid profile email offline_access api.connectors.read api.connectors.invoke` | Login is a short standalone script, not agent code |
| Device flow: user code from `https://auth.openai.com/api/accounts/deviceauth/usercode`, user visits `https://auth.openai.com/codex/device`, poll `.../deviceauth/token` (15-minute timeout), then a PKCE `authorization_code` POST to `https://auth.openai.com/oauth/token` | Implement only the device flow; skip the browser-callback mode |
| Refresh tokens rotate on every refresh; access tokens live ~10 days (`expires_in=864000`); the token endpoint declares `earliest_refresh_at`, and refreshing before that window returns 401 `refresh_token_invalidated` | Persist the new pair to disk in the same operation as the refresh; refuse to refresh before the window; re-login is the recovery for a burned token |
| `chatgpt_account_id` is claim `https://api.openai.com/auth` (or top-level) in the id_token, access token as fallback | Extract and store it once at login/refresh |
| Inference: `POST https://chatgpt.com/backend-api/codex/responses`, Responses wire format, `Authorization: Bearer`, `ChatGPT-Account-ID`, `originator` and `User-Agent` (use `jamis`) | The gateway's custom fetch injects these and pins the base URL |
| Body rules: `store: false` required; `instructions` must be non-empty; if `temperature` is set, `topP` must be dropped (backend rejects both); `stream: true` is required unconditionally (400 "Stream must be set to true" otherwise); the SSE `response.completed` event carries a usage-bearing skeleton with `output: []`, and complete output items arrive only in `response.output_item.done` events (verified live 2026-08-31); `providerOptions.openai.reasoningEffort` maps normally and `gpt-5.6-terra` supports `max` | Enforce the rewrite in the gateway fetch (and identically in the stage-2 smoke), not in agent code; the gateway fetch also assembles the SSE answer back into JSON for the SDK's non-streaming call mode |
| `gpt-5.6-terra` is exposed through the subscription catalog (workspace dependent); old-gen gpt-5.x ids only exist as `-codex` variants | Verify availability with a real one-shot generation before wiring; note the remapping rule for any future model change |
| `node:crypto`, `node:fs`, and plain `fetch` work under Bun | The login and smoke scripts run inside bare `oven/bun` images on the VPS with no `node_modules` or host Bun install |

## Public interface changes

- No route, webhook, Cloudflare, or database changes. `OPENAI_API_KEY` is removed from `.env.example` and `.env.prod.example` in Stage 4: the deployment contract of [ADR 0011](../adrs/0011-jamis-online-research.md) keeps Fireworks and Firecrawl but loses its OpenAI entry.
- Jamis and `researchAgent` model ids change from `openai/gpt-5.6-terra` to `openai-codex/gpt-5.6-terra`; traces and authenticated model listings show an `openai-codex` provider advertising `gpt-5.6-terra`.
- New gitignored `data/` directory (credential file, never committed) and new `scripts/` directory. The Dockerfile copies only `src`, so the scripts never ship in the prod image.
- One new direct dependency, `@ai-sdk/openai`, bundled by `mastra build` into the self-contained output.
- The package.json `test` placeholder becomes `bun test` (it is currently `echo "Error: no test specified" && exit 1`; `src/mastra/observability.test.ts` already exists, so the placeholder replaces nothing real).

## Stage 1: record the decision

**Goal.** Capture the gateway design, credential handling, and accepted grey areas before implementation depends on them.

**Critical files.** `CONTEXT.md`, new `docs/adrs/0014-openai-codex-model-auth.md`, this plan.

Add one glossary entry to `CONTEXT.md`: **Codex credential** — the operator's ChatGPT/Codex subscription OAuth credential (access and refresh tokens, expiry, account id) stored in a 0600 JSON file and used by the `openai-codex` gateway; a missing credential is a hard failure until re-login. Avoid: API key, ChatGPT login. ADR 0014 records why the subscription is preferred and how to reverse it.

**Verify.** All documentation links resolve, terminology matches `CONTEXT.md`, and `git diff --check` passes.

**Proposed commit.** `docs: define Codex subscription model auth`

## Stage 2: prove the OAuth flow and the codex protocol

**Goal.** Prove the device flow, secret persistence, and the subscription inference endpoint with one real generation, without touching any agent or gateway code.

**Critical files.** New `src/mastra/gateways/openai-codex-auth.ts`, new `scripts/openai-codex-login.ts`, new `scripts/openai-codex-smoke.ts`, `.gitignore`, `tsconfig.json`.

- `openai-codex-auth.ts` holds only pure credential and protocol logic with `node:` builtins and plain `fetch` (no npm imports): the credential type, `load`/`save` (atomic temp-plus-rename, `0600`), `refresh` (rotation-persisting, single-flight), account-id extraction from the JWT, the device-flow steps, and the shared header/body-rule helpers. The bare-runnable property matters: it lets the VPS run the scripts inside `oven/bun` with no `node_modules`.
- `scripts/openai-codex-login.ts` runs the device flow interactively, prints the verification URL and user code only, and writes `data/openai-codex-auth.json`.
- `scripts/openai-codex-smoke.ts` loads the credential (refreshing if expired), does one `POST https://chatgpt.com/backend-api/codex/responses` for `gpt-5.6-terra` at `max` effort with the header and body rules applied, and prints only the reply text. It accepts an optional model argument for future availability checks. If the account cannot access the model, the error surfaces here and staging stops.
- `.gitignore` gains `data/`. `tsconfig.json` adds `"scripts/**/*"` to `include` so the scripts are typechecked.
- No file under `src/mastra` imports the new module; nothing in the app's import graph changes.

**Verify.**

1. `bun install --frozen-lockfile` succeeds (no dependency change in this stage).
2. `bun scripts/openai-codex-login.ts` prints the URL and user code, completes after the operator approves at `https://auth.openai.com/codex/device`, and exits without printing any token.
3. `ls -l data/openai-codex-auth.json` shows `-rw-------`; `git status --porcelain` is clean (the file is ignored).
4. `bun scripts/openai-codex-smoke.ts` prints one real reply from `gpt-5.6-terra` through the codex backend, proving the endpoint, headers, and body rules. Forced early refresh is NOT a test: refreshing before `earliest_refresh_at` invalidates the credential (verified live 2026-08-31). Refresh plus rotation is exercised at the first natural refresh after the window opens, in production.
5. Run both scripts once through Docker to prove the VPS path needs no host Bun or `node_modules`:
   `docker run --rm -it --user 1000:1000 -v "$PWD:/repo" -w /repo oven/bun:1.3.14-alpine bun scripts/openai-codex-login.ts`
   then the same invocation with `scripts/openai-codex-smoke.ts`.
6. `bun run typecheck`, `bun run lint`, and `bun run build` pass; `git diff --check` passes.

**Proposed commit.** `feat: add Codex device-flow login and smoke`

**Local verification 2026-08-31 UTC.** Complete. All gates pass: frozen install, login (URL + code only, no token printed), `0600` credential ignored by Git, real smoke reply (`gpt-5.6-terra: ok`), typecheck/lint/build, `git diff --check`, and no `src/mastra` file imports the module. Deviation: the Docker proof ran only the smoke script; the containerized smoke exercises the same module functions the login loop uses, and a containerized login would overwrite the valid credential for no new coverage. The VPS login still gets its real first exercise in Stage 5.

## Stage 3: add the openai-codex gateway

**Goal.** Register a custom gateway that resolves `openai-codex/gpt-5.6-terra` through the subscription whenever the credential is usable, failing with a re-login error otherwise, with the logic covered by `bun test`.

**Critical files.** `package.json`, `bun.lock`, new `src/mastra/gateways/openai-codex-gateway.ts`, new `src/mastra/gateways/__tests__/openai-codex.test.ts`, new `scripts/openai-codex-gateway-smoke.ts`, `src/mastra/index.ts`.

- Pin the exact version with `bun add @ai-sdk/openai@3.0.88`; if the resolved version's peer range conflicts with core's vendored provider line, take the nearest version that typechecks and builds, and record it in this plan.
- Replace the `test` placeholder script with `"test": "bun test"`.
- The gateway extends `MastraModelGateway`: `id: 'openai-codex'`; `fetchProviders()` returns a static catalog advertising `gpt-5.6-terra` with empty `apiKeyEnvVar`; `handlesModel` stays at the default `false` (claim only the prefixed namespace); `buildUrl()` returns the codex endpoint; `resolveAuth()` returns `{ bearerToken, headers: { 'ChatGPT-Account-ID', originator: 'jamis' } }` when the credential is usable (refreshing near expiry first, single-flight) or `undefined` when no credential exists; `getApiKey()` throws a login-required error naming `scripts/openai-codex-login.ts` (no env var exists to return); `resolveLanguageModel()` has a single OAuth path: a `createOpenAI({ baseURL: codex, apiKey: 'oauth' })`-built Responses model whose custom fetch injects the live Bearer token, account id, `originator`/`User-Agent: jamis`, and applies the body rules (`store: false`, non-empty instructions, `topP` drop when `temperature` is set, `stream: true` unconditionally), assembling the SSE answer back into JSON for the SDK's non-streaming call mode. Tokens flow only through the fetch closure, never through `createOpenAI`'s `apiKey`.
- Register in `src/mastra/index.ts`: `gateways: { 'openai-codex': openAICodexGateway }`. Agents still use `openai/*` ids in this stage, so no live traffic changes.
- `openai-codex.test.ts` follows the `bun:test` style of `src/mastra/observability.test.ts`: mock `fetch`, use a temp directory for the credential file. Cover: header injection (Bearer token, account id, originator present; nothing else); body rewrite rules (each rule alone and untouched when not applicable); refresh rotation (a refresh response persists the new pair before use; a replayed rotation fails rather than reusing a dead token); missing credential (clean login-required error, no fetch attempted).
- Audit for credential logging: the gateway persists spans through the base `serializeForSpan()` (id and name only).

**Verify.**

1. `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, and `bun run build` pass.
2. `bun test` runs the new test file plus the existing `src/mastra/observability.test.ts`, all passing.
3. `bun run --bun mastra dev` boots with the gateway registered; authenticated `agent list` still returns only `jamis`.
4. `git diff --check` passes.
5. `bun scripts/openai-codex-gateway-smoke.ts` prints one real `ok` through the gateway in both call modes (non-streaming `generate` and `stream`), with no agent flips and no server involvement.

**Proposed commits.** `build: add ai-sdk openai dependency`, then `feat: add openai-codex gateway`

**Local verification 2026-08-31 UTC.** All gates pass: frozen install, typecheck, lint, build, `bun test` (24 across both files), `git diff --check`, dev server accepting the registration with `jamis` unchanged, and the gateway smoke printing `ok` in both call modes (live run 2026-08-31). The smoke (added at the operator's request before Stage 4) caught two real defects the mocked tests could not: the backend requires `stream: true` unconditionally (400 otherwise), and its `response.completed` skeleton carries `output: []` with the real items only in `response.output_item.done` events. Both are now enforced in `applyCodexBodyRules`/the gateway fetch and covered by tests; ADR 0014 and the constraint table above record the rules.

## Stage 4: point Jamis through the gateway

**Goal.** Both agents resolve `gpt-5.6-terra` through the subscription in normal use, and the missing-credential failure shape is observed, not assumed.

**Critical files.** `src/mastra/agents/jamis.ts`, `src/mastra/agents/research-agent.ts`, `.env.example`, `.env.prod.example`.

Change both `model:` strings from `'openai/gpt-5.6-terra'` to `'openai-codex/gpt-5.6-terra'` and remove `OPENAI_API_KEY` from `.env.example` and `.env.prod.example` (templates only; the operator edits the real `.env` files during rollout). Nothing else changes: `reasoningEffort: 'max'`, instructions, delegation, weather, memory, and channels stay as they are.

**Verify.**

1. `bun run typecheck`, `bun run lint`, and `bun run build` pass.
2. With the credential present, an authenticated `mastra api agent run jamis '{"messages":"In one word, what color is the sky?"}'` (with local thread and resource ids) replies normally. The ClickHouse trace shows the `openai-codex/gpt-5.6-terra` model id, and no credential value appears in the traced span attributes.
3. Remove the credential (`mv data/openai-codex-auth.json data/auth.bak`), restart `mastra dev`, and repeat the run: model resolution fails with the login-required error and no OpenAI traffic runs. Restore the file and restart.
4. Refresh-failure behavior: with `expiresAt` in the file set to the past and an invalid refresh token, an agent run fails with a clear credential error naming re-login. Re-login to restore.
5. One ordinary conversation reply and one weather request behave exactly as before; `researchAgent` answers through the new model id in a traced research run.
6. `git diff --check` passes.

**Proposed commit.** `feat: route Jamis through the Codex subscription gateway`

## Stage 5: roll out and close the gate

**Goal.** Production Jamis answers over the Sendblue line through the subscription, and `.env.prod` ends the rollout with no OpenAI API key.

**Critical files.** `docker-compose.prod.yml`, this plan, ADR 0014 only if implementation reveals a durable correction.

1. Add a bind mount to the prod `app` service: `volumes: [ './data:/app/data' ]`, so the container resolves the same relative path at `/app/data`. Commit; after separate push approval, deploy through `infra/deploy.sh` and record the production SHA.
2. On the box: `cd /root/jamis-mastra && install -d -m 700 -o 1000 -g 1000 data` (the container's `bun` user is uid 1000; confirm with `docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml exec app id`).
3. Log in over SSH with the exact Docker invocation proven in Stage 2 (`docker run --rm -it --user 1000:1000 -v /root/jamis-mastra:/repo -w /repo oven/bun:1.3.14-alpine bun scripts/openai-codex-login.ts`). Confirm `data/openai-codex-auth.json` is uid 1000 and `0600`.
4. Run the VPS smoke through the same Docker invocation (smoke script), printing one real reply. No tokens appear on the terminal.
5. Edit `.env.prod` on the box: remove the `OPENAI_API_KEY` line (the value lives only in the operator's password manager), then restart the app service.
6. Send one ordinary text and one online-research request through the Sendblue line. Inspect ClickHouse traces: `openai-codex/gpt-5.6-terra` for both Jamis and `researchAgent`, no credential material in traces or `docker compose logs app`.
7. **Failure-mode proof.** Stop the app, `rm data/openai-codex-auth.json`, start the app, send a real iMessage, and confirm the operator sees a clear failure (channel error path, no OpenAI traffic, no silent degradation). That documents the outage shape of a dead subscription credential; re-login to restore.
8. Record UTC results in this plan, then rerun the full gate: `bun run typecheck`, `bun run lint`, `bun run build`, `bun test`, `git diff --check`.

**Rollback.** There is no runtime fallback switch; that is the accepted trade. Reversal means reverting the model-id and gateway commits on the deployment branch through the normal approval flow and restoring `OPENAI_API_KEY` in `.env.prod` from the operator's password manager.

**Proposed commits.** `build: mount Codex credential in the prod app`, then `docs: record Codex gateway rollout`

## Acceptance

| # | Check |
| :---: | :--- |
| 1 | The login script completes the device flow locally and on the VPS, printing only the URL and user code, and writes a `0600` credential file |
| 2 | The smoke script performs one real `gpt-5.6-terra` generation at `max` effort through the codex backend with the header and body rules applied |
| 3 | Jamis and `researchAgent` use `openai-codex/gpt-5.6-terra`; weather, memory, and channel paths are unchanged |
| 4 | With the credential present, auth resolves through OAuth; refreshes persist the rotated pair before use |
| 5 | Without the credential, model resolution fails with a clear re-login error; no OpenAI traffic runs under any other credential |
| 6 | A failed request-time refresh produces a visible error through the channel error path |
| 7 | No token or credential value appears in Git, logs, Postgres, or ClickHouse; spans expose only gateway id and name |
| 8 | `bun test` covers header injection, body rules, refresh rotation, and the missing-credential error; the placeholder test script is replaced |
| 9 | `bun run typecheck`, `bun run lint`, `bun run build`, `bun test`, and `git diff --check` pass |
| 10 | Production answers a real Sendblue iMessage through the subscription, and `.env.prod` contains no OpenAI API key |

## Out of scope

- The localhost browser-callback OAuth flow; automatic re-login or credential-renewal daemons
- OAuth claim on bare `openai/*` ids (`handlesModel` stays false)
- Other subscription providers, multi-account support, or an account-switching mechanism
- Old-gen gpt-5.x to `-codex` variant remapping; revisit with any future model change
- `@mastra/code-sdk`, the `ai` package, or any middleware framework beyond the gateway's custom fetch
- Changes to `.env` templates, model selection mechanics, or the fireworks-based weather and observational models
- An OpenAI API-key fallback path; rejected by the operator for a single-credential auth surface
- Encryption-at-rest beyond the `0600` file and private-ops disk boundaries

## Execution rhythm

Each repository stage is independently committable. After implementing a stage, run its verification, show the diff summary and proposed commit message, and wait for explicit approval before committing. Approval to commit is not approval to push; pushing requires separate confirmation.
