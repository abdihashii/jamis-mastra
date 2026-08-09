# 001: VPS production setup and getting the agent production-ready

Status: **done.** Both tracks are complete: the stack is deployed, Studio is reachable over the tailnet, and `mastra-agent.jamis.xyz` is live behind Cloudflare Access with the bearer token behind that. Follow-ups are in the open questions below, none blocking. Decisions final per ADRs 0001-0003, the grilling session, and open question 6, do not reopen.

**The tailnet URL is the MagicDNS name, not the IP.** `tailscale serve` routes by Host header, so `http://100.105.239.41:4111` gets a 404 from tailscale before it ever reaches the app. Use `http://jamis-prod.tail024e5c.ts.net:4111` (or `http://jamis-prod:4111`). SSH is unaffected and still works over the IP.

## Current box

- `jamis-prod`, Hetzner CX23 fsn1. Public `159.69.119.203`, tailnet `100.105.239.41`.
- Public SSH is closed. Reach it at `root@100.105.239.41` over the tailnet only.
- Repo cloned to `/root/jamis-mastra`, pulling through a read-only GitHub deploy key held at `/root/.ssh/id_ed25519`.
- Created through Hetzner's web form with the cloud-init pasted in, so `provision.sh` has not been exercised end to end.

## Architecture recap

- Public ingress: Cloudflare Tunnel only, hostname `mastra-agent.jamis.xyz` → Mastra API (`app:4111`). Cloudflare Access policy at the edge.
- Private ops: Tailscale: SSH, Studio (`http://jamis-prod.tail024e5c.ts.net:4111`), nothing else. The stack publishes loopback only; `tailscale serve` fronts it on the MagicDNS name (open question 6, resolved).
- Auth in app: `SimpleAuth` bearer token (`API_TOKEN` env). Studio's first screen asks for a Mastra instance URL and headers, not a bare access token: enter the tailnet URL above, leave the API prefix blank, and add `Authorization: Bearer <API_TOKEN>`. No `public:` path exceptions needed.
- Deploy: build on VPS from git via `infra/deploy.sh` (non-interactive SSH: git pull + compose up --build). No registry, no CI, no nginx.
- Secrets: `.env.prod` on VPS, gitignored, `chmod 600`, consumed via `--env-file`.
- VPS: Hetzner CX23 (2 vCPU / 4GB, $6.49/mo), Falkenstein fsn1, Ubuntu 26.04 (ADR 0003). Provisioned by cloud-init user-data + `infra/provision.sh`. 4GB swapfile. ClickHouse memory capped at ~1.5GB. Escape hatch: re-run provision on a bigger type, or resize.
- Portability: the box is disposable. New box = `./infra/provision.sh`, `tailscale up --advertise-tags=tag:server`, a deploy key for the private repo, `.env.prod`, `tailscale serve --bg --http=4111 localhost:4111`, then `./infra/deploy.sh`. Five manual steps, not one, because no standing credentials are baked into the image.

## Out of scope

nginx, CI/CD, container registry, Terraform/Ansible, backups (follow-up: off-box `pg_dump`; ClickHouse traces expendable), cutover of `agent.jamis.xyz` from the v1 agent, multi-replica anything.

---

## Track A: VPS provisioning (scripted)

All repo files live in `infra/` at the repo root.

### A1. `infra/cloud-init.yaml` (the provisioning logic)

Goal: first boot takes a fresh Ubuntu 26.04 to a hardened, Docker+Tailscale-ready box. Declarative `#cloud-config`:

- `users:` two accounts, split by privilege:
  - `root` is the operator login, carrying your public key (committed, public keys are not secrets). Key only: `PermitRootLogin prohibit-password`, `disable_root: false`.
  - `jamis` is the agent's unprivileged host account: `lock_passwd: true`, no SSH key yet, **not** in the `docker` group (that group is root-equivalent), and no general sudo. It gets `systemd-journal` for journal reads and a pinned-argument sudoers allowlist (`docker ps`, `ps -a`, `stats --no-stream`, `compose ls`, `logs *`). `docker inspect` is excluded, it prints container env vars.
- `write_files:` sshd hardening drop-in (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`, since root is the operator login) and the `jamis` sudoers allowlist at `0440`
- `packages:` only the small stuff cloud-init needs up front (`ca-certificates`, `curl`, `gnupg`, `ufw`)
- `runcmd:` `visudo -cf` guard on the sudoers drop-in, mkswap/swapon + fstab line, apt repos + Docker/Tailscale install, ufw (default deny incoming, allow in on `tailscale0`, allow `41641/udp`, allow ssh temporarily, removed in A4), `sshd -t && systemctl restart ssh`, then the Tailscale join
- Docker and Tailscale apt repos are written in `runcmd`, not the `apt:` block: both publish per Ubuntu codename and a brand-new release may not be there yet, so the script probes for `$VERSION_CODENAME` and falls back to `noble`. cloud-init only runs once, a 404 here would leave a dead box.
- The Tailscale join tolerates an absent key: an empty or unsubstituted `${TS_AUTH_KEY}` skips it and leaves the daemon installed for a manual `tailscale up`. That is the path we actually used, see A2.
- Line 1 must be exactly `#cloud-config`. ESLint's yaml comment-spacing rule rewrites it to `# cloud-config`, which silently disables the whole file, so `infra/cloud-init.yaml` is in `ignores` in `eslint.config.mjs`.

Prereq (one-time, manual): Tailscale admin console → Access controls → add `"tagOwners": {"tag:server": ["autogroup:admin"]}`. An auth key is optional, see A2.

- Verify locally: `cloud-init schema --config-file infra/cloud-init.yaml` (brew install cloud-init) passes.

### A2. `infra/provision.sh`

Goal: one command creates a ready box. Thin wrapper, no abstraction layer. See `infra/provision.sh` for the real thing; the shape is `HCLOUD_TOKEN=... ./infra/provision.sh`, which renders the cloud-init through `envsubst` into a `mktemp` file (removed by a trap), calls `hcloud server create --type cx23 --location fsn1 --image ubuntu-26.04`, and prints the public IP. Name, type, location, image, and SSH key name are all env-overridable.

Provider switch = swap the `hcloud` line for `doctl compute droplet create jamis-prod --size s-2vcpu-4gb --region nyc3 --image ubuntu-24-04-x64 --user-data-file ...` (comment in the script). Support the provider you use, document the alternative, don't build a provider abstraction.

`TS_AUTH_KEY` is optional and better left unset. An auth key pasted into user-data becomes a standing tailnet credential readable from the Hetzner console and API for the life of the box. Skipping it costs one interactive step instead:

```bash
ssh -t root@<public-ip> 'tailscale up --advertise-tags=tag:server'   # prints a login URL, approve in browser
```

The tag matters: tagged nodes never expire, while an untagged personal node needs reauthentication every 180 days, and that lapse would cost you the only route to the box once public SSH is closed.

- Verify: script exits printing a public IP; `ssh root@<ip> 'cloud-init status --wait'` → `done`; `docker run hello-world` works; `tailscale ip -4` prints the tailnet IP.

### A3. Secrets + repo on the box (manual, one-time per box)

The repo is private, so the box needs its own read-only deploy key:

```bash
# on the box
ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -C "jamis-prod deploy key"
ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts
ssh-keygen -lf /root/.ssh/known_hosts   # must show SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU

# from your Mac, read-only on purpose (no --allow-write)
gh repo deploy-key add <pubkey-file> --title 'jamis-prod (read-only)' --repo abdihashii/jamis-mastra

# back on the box
git clone git@github.com:abdihashii/jamis-mastra.git /root/jamis-mastra
cd /root/jamis-mastra/apps/agent && cp .env.prod.example .env.prod && chmod 600 .env.prod
# edit .env.prod: FIREWORKS_API_KEY, API_TOKEN (openssl rand -hex 32), DB passwords

# publish the app to the tailnet. Compose binds 127.0.0.1 only, so without this
# Studio is unreachable. --bg survives reboots and tailscaled restarts.
tailscale serve --bg --http=4111 localhost:4111
```

- Verify: `.env.prod` filled, `git log --oneline -1` shows HEAD, `tailscale serve status` lists the 4111 proxy.

### A4. Close public SSH

The plan originally deferred this until after the first deploy. Do it as soon as tailnet SSH is proven instead: everything after this point runs over the tailnet, so there is no reason to leave port 22 facing the internet while Track B is still being written.

```bash
ssh root@<tailscale-ip> 'ufw delete allow ssh && ufw reload'
```

- Verify: `ssh root@<public-ip>` times out (ufw drops rather than refuses); `ssh root@<tailscale-ip>` still works.
- If tailscaled ever dies on the box, the only way back in is Hetzner rescue mode. `tailscaled` is enabled at boot, so reboots are fine.

**Track A boundary smoke:** fresh box → `provision.sh` → A3 → A4 → API answers over tailnet with a valid token.

---

## Track B: production-ready agent (repo changes)

B1-B4 are done, one commit each, pushed to `feat/part-1-mastra-setup`:

| stage | commit | what landed |
| --- | --- | --- |
| B1 | `21dd72d` | `.env.prod.example` (gitignore half was `33d2c90`) |
| B2 | `6aecdb9` | Dockerfile, `.dockerignore`, pnpm pin, zod install fix |
| B3 | `7a9f66f` | compose overlay, ClickHouse memory cap, deploy.sh guard removal |
| B4 | `4e4eacb` | SimpleAuth on every `/api/*` route |

Decisions behind them are in `092365b`. B5 and B6 remain, both on the VPS. The stages below keep their full detail because the first deploy is likely to send you back to them.

### B1. Secrets plumbing (done, `21dd72d`)

Goal: `.env.prod` ignored, template committed.
- ~~`.gitignore`~~ done in `33d2c90`, as `.env*` with `!.env.example` and `!.env.prod.example`. The original `.env` pattern matched only that exact name, so it never covered `.env.prod`.
- Remaining: new `apps/agent/.env.prod.example`:

```
FIREWORKS_API_KEY=
API_TOKEN=            # openssl rand -hex 32
TUNNEL_TOKEN=         # from Cloudflare dashboard (B6)
POSTGRES_PASSWORD=
DATABASE_URL=postgresql://postgres:CHANGE_ME@postgres:5432/mastra
CLICKHOUSE_URL=http://clickhouse:8123
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=
```

- Verify: `git check-ignore apps/agent/.env.prod` exits 0 (already true), and `git check-ignore apps/agent/.env.prod.example` exits 1.
- Commit: `chore: add prod env template`

### B2. Dockerfile + .dockerignore (done, `6aecdb9`)

Goal: self-contained prod image of the agent.
- `apps/agent/package.json`: build script → `"build": "mastra build --studio"` (one-word change; `--studio` on a dev build is harmless).
- New `apps/agent/Dockerfile`:

```dockerfile
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/agent/package.json apps/agent/
RUN pnpm install --frozen-lockfile
COPY apps/agent apps/agent
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm -F @jamis-mastra/agent build

FROM node:24-alpine
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/agent/.mastra/output ./
USER node
EXPOSE 4111
CMD ["node", "index.mjs"]
```

Node 24, not the 22 this plan first specified: 22 dropped to maintenance (security fixes only) in October 2025, while 24 is the Active LTS through October 2026 and supported to April 2028. It also matches the Mac's v24. Revisit when 26 becomes LTS in October 2026.

`mastra build` emits a self-contained `.mastra/output`: `index.mjs`, its own installed `node_modules`, and the `--studio` assets under `studio/`. The runtime stage copies it and nothing else. No `MASTRA_STUDIO_PATH` needed: it defaults to `<dir of index.mjs>/studio`, which is already `/app/studio`. Final image is 460MB.

`--max-old-space-size` is 2048, not the 4096 first written here. Deploys build on the box with postgres and clickhouse already running, and a cap equal to the whole 4GB invites the OOM killer to pick the largest process, which is clickhouse, taking the database down mid-deploy.

- New root `.dockerignore`: `node_modules`, `**/node_modules`, `.mastra`, `**/.mastra`, `.env*`, `**/.env*`, `.git`, `.github`, `docs`, `infra`, plus the `*.db` / `*.duckdb` families. The database patterns are not optional: `apps/agent/src/mastra/public/` holds 616KB of local LibSQL/DuckDB files from the pre-Postgres setup, `mastra build` copies `src/mastra/public/**` verbatim into the output root, and the image was shipping `/app/mastra.db` with local agent memory. It also made the local image differ from the on-box one, since `deploy.sh` builds from a fresh clone where those gitignored files do not exist.

**Three things will break this build as written, fix them in this stage:**

1. `zod` is declared in the **root** `package.json` but imported only by `apps/agent/src/mastra/tools/weather-tool.ts`. It works locally because pnpm puts it in the root `node_modules` and Node resolves upward. `pnpm install --filter @jamis-mastra/agent...` installs that package and its workspace deps, not the root project, so the build stage fails while bundling. **Resolved:** `zod` stays at the root, and the Dockerfile installs the whole workspace with a bare `pnpm install --frozen-lockfile` instead of filtering. Root dependencies stay centralized; the cost is that the build stage also installs the root devDependencies (eslint, typescript). The runtime stage is unaffected, it only copies `.mastra/output`, so the final image is the same 460MB either way. Every new workspace package needs its own `COPY <pkg>/package.json` line in the Dockerfile.
2. `packageManager: "pnpm@11.17.0"` conflicts with `devEngines.packageManager: "^11.17.0"`. pnpm reads `devEngines` and warns that it is ignoring `packageManager`; corepack reads `packageManager` first and only falls back to `devEngines` (which then needs an exact version, not a range). `corepack enable` in this Dockerfile would therefore run 11.17.0 in the image while the Mac runs 11.20.0 against one lockfile. **Resolved:** set `packageManager` to `pnpm@11.20.0`, the version actually in use, and delete the `devEngines` block. One field, both readers agree. Side effect: `devEngines` is what makes npm and npx fail in-repo with `EBADDEVENGINES`, so removing it unblocks npx-based tooling. Loses `onFail: download`, which corepack provides anyway.
3. `pnpm-workspace.yaml` shipped `allowBuilds: { esbuild: set this to true or false }`, pnpm's unanswered prompt placeholder. Locally that is a warning; in the container `pnpm install` exits 1 with `ERR_PNPM_IGNORED_BUILDS`. Set it to `false`: esbuild's postinstall only fetches the platform binary that pnpm already installs as an optional dependency, and the local build has been running with that script skipped all along.
- Verify locally: `docker build -f apps/agent/Dockerfile -t jamis-agent .` succeeds; `docker run --rm jamis-agent node --version` works; `docker run --rm jamis-agent sh -c 'ls /app/studio'` lists `index.html`; a bare `docker run` reaches `Missing required env var: DATABASE_URL`, which proves `index.mjs` is executing rather than the image merely existing.
- Commit: `feat(agent): two-stage prod Dockerfile with studio bundle`

### B3. Prod compose overlay (done, `7a9f66f`)

Goal: app + cloudflared join the existing `jamis` stack; nothing host-exposed publicly.
- New `apps/agent/docker-compose.prod.yml`:

```yaml
name: jamis
services:
  postgres:
    ports: !reset []
  clickhouse:
    ports: !reset []
    volumes:
      - ./clickhouse/memory.xml:/etc/clickhouse-server/config.d/memory.xml:ro
  app:
    build:
      context: ../..
      dockerfile: apps/agent/Dockerfile
    env_file: .env.prod
    depends_on: [postgres, clickhouse]   # no healthchecks; restart policy covers cold-start races
    ports:
      - '127.0.0.1:4111:4111'            # loopback only; tailscale serve fronts the tailnet (A3)
    restart: unless-stopped
    logging:
      driver: json-file
      options: { max-size: 10m, max-file: '3' }
  cloudflared:
    # Pinned: --no-autoupdate makes the tag the only version control.
    image: cloudflare/cloudflared:2026.7.3
    command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}
    depends_on: [app]
    restart: unless-stopped
```

  (cloudflared reaches `http://app:4111` over the compose network; no host port needed for the tunnel. `!reset []` drops the dev `127.0.0.1` bindings entirely, defense in depth, two lines.)
- Also in this stage: drop the `TAILSCALE_IP=100.` guard from `infra/deploy.sh`. It defended a variable no compose file reads any more, so leaving it in would only mislead the next reader.
- New `apps/agent/clickhouse/memory.xml`:

```xml
<clickhouse>
  <max_server_memory_usage>1500000000</max_server_memory_usage>
</clickhouse>
```

- Verify: `app`'s `env_file: .env.prod` means compose needs that file to exist even to render, and it only exists on the box. Verify with a throwaway copy (`cp .env.prod.example .env.prod`, then delete it), not by pointing `--env-file` at the template.
  - `docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml config` renders, with `app` published on `127.0.0.1:4111` and postgres, clickhouse, and cloudflared publishing nothing.
  - Full local run under an isolated project name so the dev stack is untouched: `docker compose -p jamis-prodtest ... up -d --build`. Confirmed ClickHouse merges `memory.xml` and reports `max_server_memory_usage = 1500000000, changed = 1`, an invalid file there would stop it booting. `GET 127.0.0.1:4111/api/agents` and `/` both answer 200, and the two databases end up with 36 and 25 `mastra_*` tables. Tear down with `down -v`.
  - The app logs `Storage init failed; will retry on next storage call` a handful of times at cold start, then recovers on its own and migrates both databases. That is the `depends_on`-without-healthchecks tradeoff working as intended, not a fault.
  - `cloudflared` restart-loops until B6 supplies `TUNNEL_TOKEN`. Expected, and it does not affect the rest of the stack.
- Commit: `feat(agent): prod compose overlay with app, cloudflared, CH memory cap`

### B4. SimpleAuth wiring (done, `4e4eacb`)

Goal: API requires bearer token everywhere it's served.
- `apps/agent/src/mastra/index.ts`:

```ts
import { SimpleAuth } from '@mastra/core/server';
// in the Mastra config:
server: {
  auth: new SimpleAuth({
    tokens: { [requireEnv('API_TOKEN')]: { id: 'admin', name: 'admin' } },
  }),
},
```

  `requireEnv`, not `process.env.API_TOKEN!`: the assertion would make an unset token a silent `undefined` key, which is a token nobody can present but also no loud failure. `server` has to stay a direct property of the `new Mastra()` object or the build cannot extract it.

  No `public:` exceptions. Studio workflow, as it actually behaves: open Studio over the tailnet → its config screen asks for a Mastra instance URL and headers → enter `http://jamis-prod.tail024e5c.ts.net:4111`, leave the API prefix blank, add `Authorization: Bearer <API_TOKEN>`.
- Add `API_TOKEN=` to `apps/agent/.env.example`. It is now required for `mastra dev` too, not just prod.
- Verify: against the built image, pointed at the dev databases.

  | request | result |
  | --- | --- |
  | `/api/agents` no token | 401 |
  | `/api/agents` wrong token | 401 |
  | `/api/agents` `Authorization: Bearer <token>` | 200 |
  | `/api/agents` `Authorization: <token>` | 200 |
  | `/api/agents` `X-Playground-Access: <token>` | 200 |
  | `/api/agents/weather-agent` no token | 401 |
  | `/` no token | 200, Studio shell only, no agent data |
  | `/health` no token | 200 |

  Known gaps, both accepted: `/` has to serve the Studio shell unauthenticated or there is nowhere to paste the token, and the studio-only `POST /__refresh` and `GET /refresh-events` answer 200 without a token. They trigger a UI refresh and expose no data. Everything here is tailnet-only, with Cloudflare Access in front of the public hostname.
- Commit: `feat(agent): protect API with SimpleAuth bearer token`

### B5. First deploy (done)

The two prerequisites were completed on the box, in this order: `.env.prod` filled and `chmod 600` (`API_TOKEN`, the postgres password, and the clickhouse password all generated with `openssl rand -hex`; `FIREWORKS_API_KEY` copied from the Mac; `TUNNEL_TOKEN` left blank for B6), then `tailscale serve --bg --http=4111 localhost:4111`.

Deploy is one non-interactive command from the Mac: `JAMIS_HOST=100.105.239.41 ./infra/deploy.sh`. It connects as root, fetches, checks out `JAMIS_BRANCH` (default `main`, which now carries this work), and runs `docker compose up -d --build` with both compose files. Build on the box succeeded on the CX23 without OOM, and all four services came up.

Verified:

- `curl http://jamis-prod.tail024e5c.ts.net:4111/api/agents` with no token → 401, with `Authorization: Bearer $API_TOKEN` → 200.
- Studio loads over the tailnet, lists `weather-agent`, and a live agent run returned a weather answer with its trace visible in observability. That exercises Fireworks, Postgres, and ClickHouse end to end.
- `cloudflared` restart-loops, expected until B6 supplies `TUNNEL_TOKEN`.

Two things the first deploy taught us:

- **`tailscale serve` is Host-header routed.** Requests to `http://<tailscale-ip>:4111` 404 at tailscale, never reaching the app. Use the MagicDNS name. A 404 here is a routing mismatch; a connection refused is a missing serve step; a 502 is the app being down.
- **ClickHouse logs a `generateSerialID` / `NO_ELEMENTS_IN_CONFIG` error at first boot, and it is harmless.** `@mastra/clickhouse` probes for Keeper once at init inside a `try/catch` and falls back to `farmFingerprint64` for delta cursors. The ClickHouse client logs the failed probe query itself, before Mastra swallows it. Confirmed on the box: 25 `mastra_*` tables, 6 MVs carrying the fallback expression. Later boots read the strategy off existing MV DDL and skip the probe.

- Commit: the script already landed in `31312a3` and the guard removal rode with B3. This stage's only repo change is the ClickHouse image pin plus these doc corrections.

### B6. Cloudflare dashboard (done, no repo changes)

Goal: public hostname live behind Access. What was done, in this order:

1. Zero Trust → Networks → Tunnels → create a remotely-managed tunnel named `jamis-prod`. The name is a display label over a UUID, so it can be renamed later without touching the token or DNS.
2. Tunnel → Route Traffic → Published applications: `mastra-agent` + `jamis.xyz`, empty path, service type HTTP, URL `app:4111`. The compose service name, not localhost: cloudflared shares the compose network with the app. Only this hostname; no Studio routes.
3. Access → Applications → **Public DNS** (the current name for self-hosted) → destination `mastra-agent.jamis.xyz`, one Allow policy `allow-me` with an Include rule of Emails = the operator address, all identity providers accepted (one-time PIN is the only one configured).
4. Only then the token: `TUNNEL_TOKEN` into `.env.prod`, `up -d --force-recreate cloudflared`.

**Step 3 before step 4 on purpose.** The plan originally ordered these the other way. The hostname is live on the public internet the moment the connector registers, so creating the Access application first means it is never exposed with only the bearer token in front of it.

- Verified (boundary smoke):
  - 4 `Registered tunnel connection` lines in the cloudflared log.
  - `curl https://mastra-agent.jamis.xyz/api/agents` → 302 to the Access login, never reaches the origin.
  - Browser, after completing the one-time PIN login → Mastra's own `401 {"error":"Invalid or expired token"}`. Access passed the request through and the bearer requirement stopped it. Both layers confirmed.
  - Studio loads over the tailnet MagicDNS name only.

Gotchas:

- **`--force-recreate cloudflared` recreates its dependencies too**, so the whole stack bounced. Add `--no-deps` to touch only the connector.
- The Access login page is titled with the Zero Trust **team name**, which is inherited from whatever the account was first set up for. It is not a sign that a different application is handling the hostname.
- Getting agent JSON over the public hostname needs both an Access session and the bearer header. A browser sends only the first. That is a service-token job, see open question 2.

**Cut:** healthcheck conditions on `depends_on` (restart policy suffices), Watchtower/auto-updates, docker logging daemon config, fail2ban (no public SSH left to protect), Tailscale SSH (plain sshd over tailscale0 works), provider-abstraction layer in provision.sh, Terraform/Ansible. Add any of these when a concrete pain shows up.

## Open questions / follow-ups

1. ~~Repo visibility~~ resolved: private, with a read-only deploy key on the box (A3).
2. ~~Access policy membership~~ resolved for humans: one Allow policy, Include Emails = the operator address, one-time PIN. Still open for machines: any programmatic caller from outside the tailnet needs an Access service token (a client ID and secret sent as two headers), which is a policy addition, not a repo change.
3. Backups: off-box `pg_dump` cron → object storage. Not scheduled.
4. `agent.jamis.xyz` cutover from v1 agent, separate plan.
5. ~~Memory headroom~~ resolved for now: the first `up --build` completed on the CX23 without OOM. Resize to CX33 (8GB, $8.99) if a future build starts failing.
6. ~~Open decision for B3~~ **resolved: bind `127.0.0.1:4111:4111`, front it with `tailscale serve --bg --http=4111 localhost:4111`.** The problem: docker bypasses ufw for published ports, and compose treats an empty `${TAILSCALE_IP}` as "bind everywhere" (`':4111:4111'` renders as `published: "4111"` with no host IP, which is `0.0.0.0`), which would put the API on the public internet with neither ufw nor Cloudflare Access in front. `.env.prod.example` shipped that variable blank, so the failure mode was one forgotten line.
   The rejected alternative was making it mandatory as `${TAILSCALE_IP:?...}`. Verified with compose v5.1.4: that does fail closed on blank and unset, on every path including a manual `up`. But it also fails `ps`, `down`, and `logs` unless each carries `--env-file .env.prod`, and it still lets a wrong-but-non-empty value through.
   The serve route removes the variable instead of guarding it, so no value can expose the box. `--http` serves plain HTTP on the tailnet IP, so the Studio URL is unchanged and no tailnet TLS certs are needed; `--bg` survives reboots. Cost: one manual step per box (A3), and its state lives on the box rather than in the repo. It fails safe, an unset serve means Studio is unreachable, never exposed.
7. ~~Tailscale auth key rotation~~ moot: no auth key is used. The box joined interactively as a tagged node, and tagged nodes do not expire. Reintroducing `TS_AUTH_KEY` for unattended provisioning brings the rotation problem back.
8. Data migration when switching boxes: PG/ClickHouse volumes don't move by themselves. New box = fresh databases unless you pg_dump/restore. Acceptable (deferred with backups), call it out before any provider switch.
