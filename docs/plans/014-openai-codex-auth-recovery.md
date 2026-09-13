# OpenAI Codex authentication recovery

Restore production, then ship two independently committable stages from `origin/main`:

1. Recover Codex credentials automatically when the server-declared refresh window opens, retry one generation after a `401`, and render safe Sendblue errors.
2. Let the operator run the existing Codex device flow with an exact `login openai` direct-message command.

There is no OpenAI API-key fallback, new dependency, service, database change, public endpoint, or replay of failed requests. Refresh and login coordination remain in process because production runs one JAMIS app process.

## Stage 0: production recovery

Stop the app before rotating the credential. Refresh only after `earliestRefreshAt + 60 seconds`; if the refresh token is rejected, run the existing box-side device login once. Verify the direct Codex smoke, credential mode and ownership, restart the app, then verify an ordinary iMessage reply.

Completed 2026-09-11 UTC on production SHA `5fe4d2e`. The app was stopped, the safe window was confirmed, and one refresh attempt returned `refresh_token_invalidated`. The operator completed device login instead. The replacement credential was `0600`, uid/gid `1000:1000`; the direct smoke returned `gpt-5.6-terra: ok`; the app restarted; an ordinary iMessage received a normal reply.

## Stage 1: automatic recovery and channel errors

Refresh proactively at `earliestRefreshAt + 60 seconds`, falling back to `expiresAt - 60 seconds` when the server omits the field. Never refresh earlier. On a generation `401`, reload the credential, use an already-rotated credential or join the single refresh, then retry exactly once. Repeated `401` and unavailable or failed refreshes log sanitized status/detail and throw the model-auth sentinel.

Configure Sendblue `formatError` to distinguish the model-auth sentinel from every other error. Preserve atomic credential writes, subscription-only routing, and existing request/SSE handling.

Verify proactive and forbidden refresh timing, `401` recovery, repeated `401`, refresh failure, concurrent stale requests, single-use refresh rotation, and channel redaction. Run `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`, and `git diff --check`.

Proposed commit: `fix: recover expired Codex credentials`

## Stage 2: operator-only in-chat login

Intercept exact, case-insensitive `login openai` direct messages after the existing operator-number check. Run the device flow outside the model, post and await the URL/code before polling, keep one in-memory login, suppress duplicates, and report success or failure without tokens. Do not save until login completes, persist pending state, or replay the failed request. Update ADR 0014.

Verify normalization, near-match rejection, operator-only routing, URL/code delivery, duplicate suppression, success, timeout, failure, safe credential persistence, and log/message redaction. Run the full Stage 1 gate.

Proposed commit: `feat: reauthenticate Codex from Jamis`

## Merge and rollout

After separate approvals, push and squash-merge the hotfix to `main` as `fix: recover Jamis Codex authentication`. Once the JAM-54 worktree is clean, merge `origin/main` into JAM-54 without rebasing. Preserve JAM-54's fantasy/group/recap behavior and the hotfix channel handling. Verify before the merge commit, push, and deployment, each with its own approval.

Deploy the latest JAM-54, including `a6b9d84` and `4be7a4c`. Smoke the direct gateway before iMessage login. Confirm `OPENAI_API_KEY` is absent, model ids remain `openai-codex/*`, credential mode/ownership are correct, logs and traces contain no credential material, and production answers normally. Remove the hotfix worktree only after confirming it is clean.
