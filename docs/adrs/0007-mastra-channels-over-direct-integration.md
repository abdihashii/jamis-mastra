# Mastra channels, not a direct Sendblue integration

iMessage reaches the agent through Mastra's `channels` capability with the vendor-official `chat-adapter-sendblue`, rather than a hand-written webhook route and REST call.

## Why

Mastra added `channels` in `@mastra/core@1.22.0`; this repo is on 1.59.0, so the capability was already installed and unused. It owns the parts that would otherwise each be hand-written work: the webhook route, the immediate 200 with the agent run continuing in the background, a per-thread lease so one run owns a conversation, dedupe, thread and resource ids, the typing indicator, and markdown conversion.

The cost is smaller than it looks. `chat` is already a direct dependency of `@mastra/core`, so the only new direct dependency is the adapter, which brings the official `sendblue` SDK with it. Two packages enter the tree, not the three a standalone Chat SDK setup would need.

A direct integration was the alternative, and it is genuinely small: the sibling `jamis` repo ships one at roughly 144 lines for the wire layer, and the minimum here is a subset. It was rejected because it is small only at the wire layer. Dedupe, the ack-then-work path, and the thread and resource id scheme are each real design work on top, and each is a concern this slice explicitly does not want to open.

Standalone Chat SDK, wired by hand, was also considered and is strictly worse than the framework path: three dependencies instead of one, and its in-memory state adapter loses subscriptions on restart, where Mastra's `MastraStateAdapter` persists them to the Postgres store this repo already runs.

## What we accept

- **A young vendor adapter on the one public path.** `chat-adapter-sendblue` is at 0.2.0 with two published versions ever, and it pulls the `sendblue` SDK with it. Two packages that parse untrusted internet input now run inside the container holding every secret. Pinned exact, and this is the reason why.
- **The adapter fails open on a missing webhook secret** (`dist/index.js:106`). Closed on our side by `requireEnv`, so the app refuses to boot without it. Detail in [0008](0008-public-webhook-path-through-access.md).
- **The adapter lists `chat` in both `dependencies` and `peerDependencies`.** Mastra and the adapter must resolve to one `chat` instance; a nested second copy would break the shared registry. Verified at install, not assumed.
- **Less control over the inbound path.** The sender allowlist runs in the `onDirectMessage` handler, after the adapter has already parsed and verified the request, rather than at the edge.

## Consequences

- **The webhook path is framework-generated and not configurable:** `/api/agents/<agentId>/channels/<platform>/webhook`, built from `agent.id` and the `channels.adapters` key. Renaming the agent moves the path. See [0008](0008-public-webhook-path-through-access.md) for why that matters.
- **The route is `requiresAuth: false`,** hardcoded by Mastra, so it is exempt from `SimpleAuth` without this repo configuring an exemption.
- **Channels require storage.** Already satisfied by the Postgres store.
- **Dedupe keys and locks are in-memory by design**, per `MastraStateAdapter`, which documents them as short-lived. Thread subscriptions persist. On the single long-running container this repo deploys, that is sufficient, and Redis stays out of scope.
- **A second channel is now cheap**, an adapter package and a config key, which is the main thing the direct integration would have given up.
