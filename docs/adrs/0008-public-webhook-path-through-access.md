# A public unauthenticated path through Cloudflare Access

Channel webhooks bypass Cloudflare Access. A second Access application on `mastra-agent.jamis.xyz`, scoped to the path `/api/agents/*/channels/*/webhook` with action Bypass, sits alongside the existing `allow-me` policy, which still covers everything else.

This qualifies [0002](0002-api-auth-access-plus-simpleauth.md), which reads as though every path is behind both Access and `SimpleAuth`. One class of path is behind neither.

## Why there has to be a hole

Sendblue posts inbound messages from its own infrastructure. It cannot carry an Access identity, an Access service token, or the `SimpleAuth` bearer token. Any authentication that stops strangers also stops Sendblue. Mastra reaches the same conclusion independently and hardcodes `requiresAuth: false` on the routes it generates for channel adapters, so the app-side exemption is not ours to configure.

## Why the wildcard, rather than the exact path

The narrow alternative is a Bypass on the one live path, `/api/agents/weather-agent/channels/sendblue/webhook`. It was rejected because it drifts, and drifts silently.

The path is built from `agent.id` and the adapter key, neither configurable. Renaming `weather-agent` to `jamis` moves it, and so does every new channel. If the Access rule is not updated in the same change, Sendblue's POST hits Access instead of the app, gets a 302 to a login page, retries, and gives up. Nothing errors on our side. The phone just goes quiet.

`/api/agents/*/channels/*/webhook` encodes the actual invariant: channel webhooks are public by construction. Its blast radius is exactly the set of routes Mastra already marks `requiresAuth: false`, so the bypass grants nothing the framework has not already decided is unauthenticated. Cloudflare permits one wildcard between each pair of slashes, so the pattern is legal; note that a mid-path wildcard spans multiple segments, so the match is broader than one segment each.

## Rejected alternatives

- **Access service token.** Sendblue cannot send the client ID and secret headers.
- **A separate hostname** (`hooks.jamis.xyz`, no Access application) with a cloudflared ingress path rule. Keeps `mastra-agent.jamis.xyz` untouched, but costs a DNS record and a second ingress rule, and a wrong path rule exposes the entire API behind `SimpleAuth` alone. The failure mode is worse than the one it avoids.
- **A route outside `/api/`.** This was the plan before Mastra's `channels` was found. It is no longer available: the framework generates the path and it is inside `/api/`.
- **Polling instead of a webhook.** Sendblue's model is push, and polling trades a public path for latency and wasted calls.

## What guards the path instead

The two guards defend different perimeters. They are sequential, not parallel, and the order matters.

- **The shared secret guards against the public internet.** Sendblue echoes the configured `SENDBLUE_WEBHOOK_SECRET` in the `sb-signing-secret` header and the adapter compares it. This is a shared secret, not an HMAC, so it proves the caller holds the secret and says nothing about the body.
- **The allowlist guards against the public phone network.** Anyone who learns the Sendblue line can text it, and Sendblue will deliver that faithfully with a valid secret. The operator-number check in `onDirectMessage` is the only thing that stops a stranger's text from reaching the model. Anything else is dropped with no reply, and `onMention` and `onSubscribedMessage` are disabled so a direct message is the only route in.

**The allowlist is downstream of the secret, not a second independent layer.** It compares `from_number`, which comes from the request body and is therefore attacker-controlled. It is trustworthy only because the secret established that Sendblue sent the body. If the secret is absent, the allowlist is worthless: a forged body simply claims the operator's number.

That matters because **the adapter fails open**. `chat-adapter-sendblue@0.2.0` wraps its verification in `if (this.config.webhookSecret)` (`dist/index.js:106`), so an unset or empty secret skips the check and accepts every request. `SENDBLUE_WEBHOOK_SECRET` therefore goes through `requireEnv` and the app refuses to boot without it. This repo has met this failure mode before, in plan 001's blank `${TAILSCALE_IP}` rendering as bind-everywhere.

The comparison is also a plain `!==` rather than constant-time. A remote timing attack across Cloudflare is not practical, so this is recorded rather than mitigated.

- **A fast 200 limits what an unauthenticated caller can hold open.** Mastra answers the webhook immediately and runs the agent in the background. Thread creation and the model call both live inside `defaultHandler`, so a rejected sender causes no database write and no model spend.

## Consequences

- **`SimpleAuth` is the only remaining layer on the rest of `/api/*` if this rule is ever widened.** Treat any edit to it as security work.
- **Verify Access did not widen after the rule lands.** `curl https://mastra-agent.jamis.xyz/api/agents` must still 302 to the Access login.
- **The rule survives the Jamis rename and future channels** with no Access edit, which is the point of choosing it.
- **A channels route added by a future Mastra version inherits the bypass** without an explicit decision here. That is the accepted cost of encoding the invariant instead of the instance.
