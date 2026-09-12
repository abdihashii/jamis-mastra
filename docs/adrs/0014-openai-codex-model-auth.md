# Jamis model auth through the Codex subscription gateway

Jamis's OpenAI models will authenticate through the operator's ChatGPT/Codex subscription via a custom Mastra `openai-codex` model gateway, using OAuth device-flow credentials stored in a private file. There is no API-key fallback: no OpenAI API key in any environment.

## Context

Jamis and its research subagent use `gpt-5.6-terra` at `max` reasoning effort, currently authenticated by a platform API key that bills per token. The operator already pays for a ChatGPT/Codex subscription whose model usage is quota-based. Mastra Code, the framework's own CLI, authenticates that same subscription through a public OAuth client and an undocumented `https://chatgpt.com/backend-api/codex/responses` endpoint speaking the OpenAI Responses wire format. `@mastra/core@1.61.0` supports custom model gateways registered on the Mastra instance, and its gateway chain tries OAuth/stored credentials before falling back to API-key env vars.

## Decision

- Add a custom `openai-codex` gateway; Jamis and `researchAgent` switch to model id `openai-codex/gpt-5.6-terra`. The gateway id is a namespace: bare `openai/*` ids keep their existing models.dev path.
- Authenticate with the Codex public client over the headless device flow (PKCE, 15-minute poll), run by a standalone login script over SSH; no browser-callback mode. The credential (access token, rotating refresh token, expiry, server-declared refresh window, account id) lives in a `0600` gitignored JSON file on disk; the agent process never receives the refresh token through env. Refreshes persist the rotated pair to the file before using the new access token, because old refresh tokens die on rotation — and refreshing before the server-declared `earliest_refresh_at` window invalidates the credential outright, so the gateway refuses early refreshes and re-login is the only recovery for a burned or failed refresh.
- The gateway resolves inference as an `@ai-sdk/openai` Responses model with a custom `fetch` that pins the codex endpoint, injects the Bearer token, `ChatGPT-Account-ID`, and `originator`/`User-Agent: jamis`, and enforces the backend's body rules (`store: false`, non-empty `instructions`, drop `topP` when `temperature` is set, `stream: true` unconditionally — the backend rejects non-streaming requests with 400). Because the SDK's non-streaming call mode sends no `stream` field, the fetch translates the mandatory SSE answer back into a plain JSON body: it assembles `response.output_item.done` items onto the terminal `response.completed` skeleton (whose `output` is always empty) so `doGenerate` calls work unchanged. The SDK must also *see* `store: false` when it serializes prior turns: with the default `store: true` it replays previous assistant messages and reasoning as `item_reference` ids the backend has no store for, which 404s; the resolved language model therefore wraps the provider to force `providerOptions.openai.store = false` so history is replayed by value. Do not depend on `@mastra/code-sdk` or add the `ai` package.
- No `OPENAI_API_KEY` fallback, by operator choice: no OpenAI API key in `.env` files, templates, or the VPS. A missing credential is a hard failure; a dead refresh at request time fails loudly through the channel error path. Thrown model-auth errors say only "Model authentication failed. The error was logged." over the operator's messaging channel — they render verbatim as chat text — while the recovery detail (the login script, the no-fallback fact) goes to server logs. One credential means one auth surface and an unambiguous outage signal instead of silent billed fallback traffic.
- The operator can start the same device flow from a direct iMessage with exact, case-insensitive `login openai`. JAMIS intercepts it after the operator-number check and outside the model, waits for the URL/code post before polling, permits one in-process flow, and reports duplicate, success, timeout, or failure with static text. It never replays the failed model request or exposes credential values, account ids, or raw provider responses.
- Accept the quota-not-billing model: subscription usage is subject to rate limits and workspace-dependent model availability rather than per-token charges.

## Alternatives not taken

- **Keep `OPENAI_API_KEY` only.** Simplest, but pays per token for capability the subscription already covers.
- **Subscription with automatic API-key fallback.** Rejected by the operator: it keeps a second secret in every environment and lets a dead subscription hide behind billed API traffic with no visible failure.
- **`@mastra/code-sdk`.** It implements this OAuth flow, but drags duckdb, libsql, GitHub signals, and an agent controller into a personal agent stack.
- **`ai` package middleware for body rules.** A small `fetch` rewrite does everything the middleware would.
- **Claim bare `openai/*` ids via `handlesModel`.** Keeps auth plumbing ambiguous; an explicit namespace makes the auth mode visible in traces and listings.

## Consequences

- Model usage moves from per-token billing to the subscription's quota; a heavy day can hit rate limits and surface as errors rather than charges.
- `OPENAI_API_KEY` leaves `.env.example`, `.env.prod.example`, and the VPS `.env.prod`; the deployment contract of ADR 0011 keeps Fireworks and Firecrawl but loses its OpenAI entry.
- The inference endpoint is undocumented; the request shape is enforced by the gateway's body rules, and OpenAI-side changes can break it abruptly. With no fallback, that break is an immediate outage until the gateway or credential is fixed.
- Automating one's own single-user account against this backend is a ToS grey area. A single-user, own-account usage pattern with a personal agent is the lowest-risk posture; the account-automation ban warnings reported on the Anthropic side do not transfer here. The operator accepts the risk for their own subscription.
- Model availability is workspace-dependent; `gpt-5.6-terra` is exposed today, but old-gen gpt-5.x ids only exist as `-codex` variants, so a future model change may require remapping.
- Credential security is the file: `0600`, gitignored, owned by the container user, never in env, never logged, and excluded from tracing spans (gateways serialize only id and name).
- In-chat login coordination is process-local, matching the single JAMIS process. A restart abandons the pending flow; the operator sends `login openai` again.

## Reversal

Revert the model-id and gateway commits on a branch, restore `OPENAI_API_KEY` in the local `.env` and the VPS `.env.prod` (the value lives only in the operator's password manager), and restart. There is no runtime switch; reversal is a deploy-level action.
