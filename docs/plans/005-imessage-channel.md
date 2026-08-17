# 005: the iMessage channel

Status: **Stages 1-3 complete locally.** Stage 4 requires fresh explicit production approval. Stage 5 remains pending.

Text the Sendblue line from the operator number, get a real answer back from `weather-agent`.

One concern only: the channel. No Jamis agent, no memory design, no supervisor, no specialists. `weather-agent` is the target because it already answers, already calls a tool, and already writes to Postgres and ClickHouse, so a failure in this plan is unambiguously the channel's fault. The demo reads as "text the number, get a forecast" rather than "talk to Jamis", and that is deliberate.

Off `main` at `4eb0ab4`. Branch `feat/imessage-channel`.

## Decisions

Settled during planning, with the reasoning in the ADRs:

- **Mastra `channels`, not a direct integration.** [0007](../adrs/0007-mastra-channels-over-direct-integration.md).
- **Access bypass on `/api/agents/*/channels/*/webhook`.** [0008](../adrs/0008-public-webhook-path-through-access.md).
- **The allowlist runs in `onDirectMessage`.** `onMention` and `onSubscribedMessage` are disabled, so a direct message is the only path to the agent. A non-allowlisted sender is dropped with no reply.
- **`toolDisplay: 'hidden'`, `typingStatus` left at its default `true`.** One text in, one text out, with the typing bubble while the agent works. The default `'cards'` renders nothing useful on iMessage, and `'text'` would narrate `weatherTool` on every question.
- **`gateway: false`,** set explicitly. Sendblue is webhook-only; Mastra only starts a gateway loop when the adapter implements `startGatewayListener`, so this is documentation of intent rather than a behavior change.
- **Local verification replays a synthetic inbound with curl.** No tunnel, no local webhook registration. Prod proves the one leg curl cannot.

### Facts this plan depends on

Verified against installed code and vendor docs during planning, so they do not need re-deriving:

| Fact | Source |
| :--- | :--- |
| `channels` exists, added in `@mastra/core@1.22.0`; repo is on `1.59.0` | Installed `package.json` |
| Webhook path is `/api/agents/${agent.id}/channels/${adapterKey}/webhook`; it is not configurable | `agent-CKAVuxKN.js:20257,20603` |
| The webhook route is hardcoded `requiresAuth: false` | `agent-CKAVuxKN.js:20605` |
| `chat@4.38.0` is already in the tree through `@mastra/core` | `@mastra/core/package.json:871` |
| `chat-adapter-sendblue@0.2.0` peers `chat >=4.0.0` and depends on `sendblue@^3.6.1` | npm metadata |
| Only adapter versions `0.1.0` and `0.2.0` were published | npm metadata |
| Default state is `MastraStateAdapter`.<br>Subscriptions persist to storage; dedupe keys and locks stay in memory. | `channels/state-adapter.d.ts` |
| `sb-signing-secret` carries the configured shared secret verbatim, not an HMAC | Sendblue and Chat SDK docs |
| Inbound `from_number` is E.164 with a leading `+` | Sendblue webhook docs |
| `receive` webhooks are account-level; create appends to the array | Sendblue webhook docs |
| Adapter env names are `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, and `SENDBLUE_FROM_NUMBER` | Sendblue and Chat SDK docs |
| Default `resourceId` is `${platform}:${message.author.userId}`.<br>Default `threadId` is a random UUID. | Mastra channels reference |
| Markdown is rendered as plain text; streaming is unsupported | Chat SDK adapter docs |
| Cloudflare permits one wildcard between slash pairs; a mid-path wildcard spans segments | Cloudflare Access path docs |

### Adapter behavior, read from the published source

`chat-adapter-sendblue@0.2.0` was unpacked and read during planning. Four things it does are load-bearing here:

| Behavior | Location | Consequence |
| :--- | :--- | :--- |
| `if (this.config.webhookSecret) { ...verify... }` | `dist/index.js:106` | **Fails open.**<br>An unset or empty secret skips verification and accepts every request. |
| `headerValue !== this.config.webhookSecret` | `dist/index.js:109` | Plain string comparison, not constant-time. |
| `author.userId = raw.from_number` | `dist/index.js:185` | The allowlist receives the documented E.164 number with a leading `+`. |
| `isDM: !decoded.groupId` | `dist/index.js:342` | 1:1 reaches `onDirectMessage`.<br>Groups have no enabled handler and are dropped. |

The fail-open is the reason `SENDBLUE_WEBHOOK_SECRET` goes through `requireEnv` in stage 2. This repo has met this failure mode before: plan 001's open question 6 was a blank `${TAILSCALE_IP}` rendering as bind-everywhere. Same shape, same fix, refuse to boot.

### Known unknown

One thing planning could not settle:

- **Whether `bun add` hoists a single `chat`.** The adapter lists `chat` in both `dependencies` and `peerDependencies`. Mastra and the adapter must share one instance. Checked in stage 1.

---

## Stage 1: dependency and env templates

**Status.** Complete.

**Goal.** The adapter is installed, resolves to one shared `chat`, and both env templates carry the new keys. No code wired yet.

**Critical files.** `package.json`, `bun.lock`, `.env.example`, `.env.prod.example`.

`bun add --exact chat-adapter-sendblue@0.2.0`. Exact, per [0007](../adrs/0007-mastra-channels-over-direct-integration.md): a 0.2.0 vendor package on the public path does not float.

Both templates gain empty keys: `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`, `SENDBLUE_WEBHOOK_SECRET`, `JAMIS_ALLOWED_NUMBER`. Values only ever land in `.env` locally and `.env.prod` on the box.

**Verify.**

- `bun pm ls | grep -c chat@` resolves to a single hoisted `chat@4.38.0`, and `ls node_modules/chat-adapter-sendblue/node_modules` shows no nested copy. This is the peer-dependency risk above; if it fails, stop and resolve before stage 2.
- `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint` clean.
- `bun run dev` still boots and serves `/api/agents`.

**Commit.** `chore: add the sendblue chat adapter and env templates`

---

## Stage 2: the channel, wired

**Status.** Complete.

**Goal.** The full config, plus the boot-time guard that closes the adapter's fail-open.

**Critical files.** `src/mastra/agents/weather-agent.ts`, `src/mastra/index.ts`, new `src/mastra/channels/sendblue.ts`.

`requireEnv` currently lives in `src/mastra/index.ts` and is not exported. The channel config needs it too, so it moves to its own module and both files import it. That move is part of this stage, not a drive-by refactor.

`src/mastra/channels/sendblue.ts` holds the adapter construction and `isOperator`, so `weather-agent.ts` keeps to describing the agent. It is also where the stage 3 fixture lives.

`requireEnv` covers **both** `SENDBLUE_WEBHOOK_SECRET` and `JAMIS_ALLOWED_NUMBER`, alongside the existing secrets. The adapter treats its secret as optional and skips verification when it is falsy, so a blank value in `.env.prod` would silently open the path to the whole internet. Failing at boot is the only thing standing between a forgotten line and an open agent.

The adapter is constructed with the secret passed explicitly rather than read from the environment, so the value that boot validated is the value that verifies.

```ts
channels: {
  adapters: {
    sendblue: {
      adapter: createSendblueAdapter({
        webhookSecret: requireEnv('SENDBLUE_WEBHOOK_SECRET'),
      }),
      toolDisplay: 'hidden',
      gateway: false,
    },
  },
  handlers: {
    onDirectMessage: async (thread, message, defaultHandler) => {
      if (!isOperator(message)) return
      await defaultHandler(thread, message)
    },
    onMention: false,
    onSubscribedMessage: false,
  },
},
```

`allowedServices` stays at its default, so inbound is iMessage only. `typingStatus` stays at its default `true`. `threadContext` is left alone: `maxMessages` applies only to non-direct-message threads, so it is moot for a 1:1 conversation.

`isOperator` compares `message.author.userId` against `JAMIS_ALLOWED_NUMBER`. Per the adapter source that value is `from_number`, E.164 with a leading `+`, so the env var is stored in the same form and compared after `trim()`.

**Verify.** `bun run typecheck` and `bun run lint` clean. `bun run dev` boots, and the startup log shows `MastraStateAdapter` in use and no gateway loop. Blanking `SENDBLUE_WEBHOOK_SECRET` in `.env` fails the boot with a named error, which is the fail-open guard doing its job.

**Commit.** `feat: wire the sendblue channel to weather-agent`

---

## Stage 3: local proof by replay

**Status.** Complete locally. No Stage 3 commit was made.

**Goal.** Everything except Sendblue's inbound delivery, proven on localhost.

**Critical files.** a synthetic fixture alongside `src/mastra/channels/sendblue.ts`.

The fixture is the payload from Sendblue's public webhook docs with reserved test numbers, **not a captured real message**. A real capture would put the operator number and personal message content into git history. For a real local replay, rewrite the phone-number fields from local `.env` in memory, never in the tracked fixture.

Replay it against the local server:

```
curl -X POST localhost:4111/api/agents/weather-agent/channels/sendblue/webhook \
  -H 'content-type: application/json' \
  -H "sb-signing-secret: $SENDBLUE_WEBHOOK_SECRET" \
  -d @fixture.json
```

Outbound is an ordinary API call, so this sends a real text from the local process. The phone should buzz.

**Verify.** Each of these is a separate run:

| Check | Expected | Result |
| :--- | :--- | :--- |
| Valid replay | Fast `200`; one forecast | **Passed locally.** `200`; one forecast |
| No `sb-signing-secret` header | Rejected; no reply or agent run | **Passed locally.** `401` |
| Wrong secret value | Rejected; no reply or agent run | **Passed locally.** `401` |
| Different `from_number` | `200`; silent drop; no Postgres thread | **Passed locally.** `200`; no new thread or message |
| Two immediate identical replays | One reply, not two | **Passed locally.** Two `200`s; one reply |
| Populated `group_id` | No handler fires; dropped | **Passed locally.** `200`; no new thread or message |
| Postgres | Messages increase; a channel thread exists | **Passed locally.** One channel thread; four channel messages |
| ClickHouse | Trace root exists | **Passed locally.** Two successful-run trace roots |
| Unauthenticated `GET /api/agents` | `401` from `SimpleAuth` | **Passed locally.** `401` |

**Commit.** none, or a docs-only commit if the curl recipe is worth keeping.

---

## Stage 4: prod

**Goal.** The one leg curl cannot prove. **Needs explicit sign-off before anything here runs.** Prod is live and healthy at `4eb0ab4`.

**Critical files.** none in the repo. Cloudflare dashboard, Sendblue account, `.env.prod` on the box.

Order matters:

1. Fill the five new keys in `.env.prod` on the box, `chmod 600`.
2. Add the Access application: `mastra-agent.jamis.xyz/api/agents/*/channels/*/webhook`, action **Bypass**. Leave `allow-me` alone.
3. Confirm Access did not widen **before** deploying: `curl -sI https://mastra-agent.jamis.xyz/api/agents` still 302s to the Access login, and the webhook path no longer 302s.
4. `JAMIS_HOST=<host> ./infra/deploy.sh`.
5. Register exactly one `receive` webhook at `https://mastra-agent.jamis.xyz/api/agents/weather-agent/channels/sendblue/webhook` with the secret from `.env.prod`. The create endpoint appends rather than replaces, so list first and delete anything stale.

**Verify.**

| Check | Expected |
| :--- | :--- |
| Text the Sendblue line from the operator number | One forecast; typing bubble first |
| Unauthenticated `GET /api/agents` | `302` to Access login |
| Bearer-token `GET /api/agents` over the tailnet | `200` |
| Unsigned webhook POST | Rejected; no reply |
| `sendblue` webhook list | Exactly one `receive` entry |
| ClickHouse | Trace root for the phone-originated run |
| `docker volume ls` | `jamis_pgdata` and `jamis_chdata` present |

**Kill switch and rollback.** In order of speed, because the failure being guarded against is an open path on a live box:

1. **Delete the Sendblue `receive` webhook.** Fastest and needs no deploy. Inbound stops immediately and the rest of prod is untouched. This is the first move for anything unexpected.
2. **Delete the Access Bypass application.** Closes the hole at the edge without touching the box. Sendblue then gets a 302 and gives up.
3. **Redeploy `4eb0ab4`.** `JAMIS_BRANCH=main` after reverting, or check out the tag directly. That commit is the rollback target: it is what prod runs today and has been healthy.

Steps 1 and 2 are independent of the deploy, so a bad outcome does not require a rebuild to stop the bleeding.

**Commit.** none. Deploy only.

---

## Stage 5: docs

**Goal.** Record what shipped.

**Critical files.** this file, `CONTEXT.md`, `docs/adrs/0007-*`, `docs/adrs/0008-*`, `docs/adrs/0002-*`.

The glossary terms (**Channel**, **Sendblue line**, **Operator number**), the correction to **Public ingress**, both ADRs, and the cross-reference from 0002 were all written during planning and land here. This stage adds the verified-results column and anything the build learned.

**Commit.** `docs: record the imessage channel decisions`

---

## Acceptance

| # | Check | Result |
| :---: | :--- | :--- |
| 1 | Operator text gets a forecast | **Local pass.** Production pending Stage 4. |
| 2 | One inbound message, one outbound message, typing bubble | **Local message flow passed.** Typing bubble remains for Stage 4. |
| 3 | Unsigned webhook is rejected | **Passed locally.** |
| 4 | Non-allowlisted number is dropped | **Passed locally.** |
| 5 | Public `/api/agents` still redirects to Access | Pending Stage 4. |
| 6 | One hoisted `chat`, no nested copy | **Passed Stage 1.** |
| 7 | One registered `receive` webhook | Pending Stage 4. |
| 8 | `jamis_pgdata` and `jamis_chdata` remain intact | **Local volumes present.** Production pending Stage 4. |
| 9 | Blank `SENDBLUE_WEBHOOK_SECRET` refuses boot | **Passed Stage 2.** |

## Accepted residual risk

Named rather than fixed, because fixing each is its own concern:

- **No rate limiting on the public path.** Dedupe stops identical retries, not distinct messages. Anyone holding the secret can drive model spend. A Cloudflare WAF rate-limit rule on the same path pattern is the cheap mitigation if this ever matters.
- **Two young packages parse untrusted internet input inside the app container.** `chat-adapter-sendblue@0.2.0` (two published versions ever) and its `sendblue` SDK dependency. That container holds `FIREWORKS_API_KEY`, `API_TOKEN`, `DATABASE_URL`, and the ClickHouse credentials, so a parsing-chain compromise reaches all of them. Both are pinned through the lockfile; this is the main reason the version is exact.
- **Read receipts precede authorization.** The adapter calls `markRead` on every inbound before any handler runs, so a stranger texting the line sees their message marked read even though it is dropped. It confirms the line is live. Cosmetic.
- **Inbound message text reaches ClickHouse unredacted.** `SensitiveDataFilter`'s defaults are credential keywords (`password`, `token`, `secret`, `key`, `auth`), not phone numbers or message bodies. Contained to private ops, since ClickHouse has no host port in prod, but this is the first personal conversation content entering observability storage.
- **The allowlist is downstream of the secret, not parallel to it.** See [0008](../adrs/0008-public-webhook-path-through-access.md).

## Out of scope

Named so they are not drifted into: the Jamis agent, memory architecture, group messages, media in or out, tapbacks, SMS and RCS fallback, delivery status callbacks, Redis for shared dedupe, a second channel, and `agent.jamis.xyz`.

## Notes for whoever builds this

- **Never `docker compose down -v`.** `jamis_pgdata` is the only unrecoverable state.
- **Per-stage sign-off before every commit. "Ok to commit" is not "ok to push."**
- The webhook is a public unauthenticated path. Any change to its guards is security work.
- Sendblue's typing indicator silently no-ops when `from_number` is missing from the request body, and auto-expires at 60s. Carried over from JAM-21 in the sibling repo. The adapter should supply it from `SENDBLUE_FROM_NUMBER`; if no bubble appears, that is the first thing to check.
- `weather-agent` currently 500s on a bare `generate()` without a `memory: {thread, resource}` block, because `observationalMemory.scope` sits at its `'thread'` default. The channel path supplies both ids, so this should not bite here. If it does, it is the channel failing to create a thread, not the agent.
