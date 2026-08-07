# API auth: Cloudflare Access plus a bearer token in the app

The public Mastra API is protected in two places. Cloudflare Access sits in front of the tunnel hostname and checks callers before traffic reaches the VPS. Inside the app, Mastra's `SimpleAuth` middleware checks a static bearer token loaded from an env var. The token check also covers calls made over the tailnet, which skip the tunnel.

We chose this over Access alone (tailnet calls would be unauthenticated) and over the token alone (nothing stops strangers at the edge). The tokens are static and never expire. That is fine for a single operator. If outside users ever appear, we can switch to JWT or a login provider.
