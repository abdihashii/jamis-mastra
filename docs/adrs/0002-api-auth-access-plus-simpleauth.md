# API auth: Cloudflare Access at the edge + SimpleAuth bearer token in the app

The publicly exposed Mastra API is protected twice. Cloudflare Access sits in front of the tunnel hostname as the edge front door. Inside the app, Mastra's `SimpleAuth` middleware (from `@mastra/core/server`) checks a static bearer token loaded from an env var, which also covers direct calls over the tailnet that bypass the tunnel.

Chosen over edge-only (tailnet access would be unauthenticated) and app-only (no edge defense in depth). Tokens are static and never expire; acceptable for a single-operator deployment, upgrade path is the JWT or an identity-provider adapter if external users ever appear.
