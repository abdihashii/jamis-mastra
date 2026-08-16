# API auth: Cloudflare Access plus a bearer token in the app

The public Mastra API is protected in two places.

1. Cloudflare Access sits in front of the tunnel hostname and checks callers before traffic reaches the VPS.
2. Inside the app, Mastra's `SimpleAuth` middleware checks a static bearer token loaded from an env var. The token check also covers calls made over the tailnet, which skip the tunnel.

We chose this over Access alone (tailnet calls would be unauthenticated) and over the token alone (nothing stops strangers at the edge).

One class of path is behind neither: channel webhooks, which the messaging platform must reach unauthenticated. See [0008](0008-public-webhook-path-through-access.md).

The tokens are static and never expire. That is fine for a single operator. If outside users ever appear, we can switch to JWT or a login provider.
