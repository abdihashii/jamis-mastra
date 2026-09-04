# Personal-accounts agent owns personal-account integrations

Jamis gains its first personal-account integration (read-only Gmail). Unlike ADR 0009's per-capability ownership (weather-tool on weather-agent, Firecrawl on research-agent), integrations with the operator's personal accounts get one shared internal subagent, `personal-accounts-agent` on Jamis's `agents` property, because the coming set (Gmail now, Calendar next, not Google-only) shares one OAuth credential surface, one delegation boundary, and one PII-class trace home. See plan when written; deviates from 0009 deliberately.

## Decisions

- One internal subagent owns the account class. Never registered on the root Mastra instance; only Jamis delegates; delegation prompt carries only the task (research-agent messageFilter precedent).
- v1 is read-only Gmail via a single `gmail-search` tool: plain `fetch` against the Gmail REST API, no googleapis dependency. Sending requires an ADR 0012 text-check and is a follow-up.
- OAuth: Google Desktop-app client, consent screen published to Production (Testing expires refresh tokens in 7 days), scope pinned to `gmail.readonly` (a restricted scope; unverified-app warning accepted for the single operator). Headless capture: `login:google` script over SSH with a 127.0.0.1 loopback listener reached via `ssh -L` from the Mac (Google's device flow does not support Gmail scopes; OOB copy-paste is deprecated). Credential is a 0600 gitignored JSON in `data/` per the Google credential term; missing or dead credential fails with a generic channel message, recovery detail only in server logs.
- Data policy: accept existing retention defaults. Full tool results persist in private Postgres message records; ClickHouse spans truncate strings at 1024 chars. The credential never enters any exported record; a post-deploy scan (ADR 0013 pattern) verifies.

## Alternatives not taken

- **Per-API subagents (email-agent, calendar-agent...)**: multiplies prompts, credentials plumbing, and trace homes for one shared auth surface.
- **Tool on Jamis directly**: contradicts ADR 0009 scoped ownership; blurs the credential boundary.
- **Gmail MCP server**: no auth story in this repo for remote MCP with user credentials.
- **Composio (managed integration platform)**: on self-serve plans the OAuth callback runs through Composio's backend and tokens are stored in Composio's cloud even with a bring-your-own OAuth app; keeping Gmail tokens on-premises means self-hosting their full platform runtime. For one operator and one restricted scope, a third-party cloud in the credential path contradicts ADR 0014's on-box stance.
- **Refresh token in env / `.env.prod`**: contradicts ADR 0014's stance for OAuth refresh tokens.
- **OOB paste or device flow**: invalid for Gmail scopes per Google's docs.
- **Redacting bodies from ClickHouse spans**: Postgres retains full results regardless; lopsided until message-level retention exists.

## Known limits

- Gmail-scoped refresh tokens die if the operator changes their Google account password; also on revocation, 6-month disuse, or the 100-token-per-client limit. Recovery is always re-running `login:google`.
- Email content persistence follows the no-TTL reality of the current storage configuration (ADR 0011 consequence), now for a higher sensitivity class, accepted here.
