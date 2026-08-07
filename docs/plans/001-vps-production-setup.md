# 001 — VPS production setup & agent productionalization

Status: proposed. Decisions final per ADRs 0001-0003 and grilling session, do not reopen.

## Architecture recap

- Public ingress: Cloudflare Tunnel only, hostname `mastra-agent.jamis.xyz` → Mastra API (`app:4111`). Cloudflare Access policy at the edge.
- Private ops: Tailscale: SSH, Studio (`http://<tailscale-ip>:4111`), nothing else.
- Auth in app: `SimpleAuth` bearer token (`API_TOKEN` env). Studio authenticates by pasting the same token into Studio's access-token field (SimpleAuth checks `X-Playground-Access` by default, no `public:` path exceptions needed).
- Deploy: build on VPS from git via `infra/deploy.sh` (non-interactive SSH: git pull + compose up --build). No registry, no CI, no nginx.
- Secrets: `.env.prod` on VPS, gitignored, `chmod 600`, consumed via `--env-file`.
- VPS: Hetzner CX23 (2 vCPU / 4GB, $6.49/mo), Falkenstein fsn1, Ubuntu 26.04 (ADR 0003). Provisioned by cloud-init user-data + `infra/provision.sh`. 4GB swapfile. ClickHouse memory capped at ~1.5GB. Escape hatch: re-run provision on a bigger type, or resize.
- Portability: the box is disposable. New box = `./infra/provision.sh` + one secrets step + `./infra/deploy.sh`.

## Out of scope

nginx, CI/CD, container registry, Terraform/Ansible, backups (follow-up: off-box `pg_dump`; ClickHouse traces expendable), cutover of `agent.jamis.xyz` from the v1 agent, multi-replica anything.

---

## Track A — VPS provisioning (scripted)

All repo files live in `infra/` at the repo root.

### A1. `infra/cloud-init.yaml` (the provisioning logic)

Goal: first boot takes a fresh Ubuntu 26.04 to a hardened, Docker+Tailscale-ready box. Declarative `#cloud-config`:

- `users:` two accounts, split by privilege:
  - `root` is the operator login, carrying your public key (committed, public keys are not secrets). Key only: `PermitRootLogin prohibit-password`, `disable_root: false`.
  - `jamis` is the agent's unprivileged host account: `lock_passwd: true`, no SSH key yet, **not** in the `docker` group (that group is root-equivalent), and no general sudo. It gets `systemd-journal` for journal reads and a pinned-argument sudoers allowlist (`docker ps`, `ps -a`, `stats --no-stream`, `compose ls`, `logs *`). `docker inspect` is excluded, it prints container env vars.
- `write_files:` sshd hardening drop-in (`PasswordAuthentication no`, `PermitRootLogin no`), 4GB swapfile entry, ClickHouse-ready sysctl nothing (skip, ponytail)
- `packages:` via Docker's official apt repo (`apt: sources:` + `packages: [docker-ce, docker-ce-cli, containerd.io, docker-compose-plugin]`), plus `tailscale` from Tailscale's apt repo
- `runcmd:` mkswap/swapon + fstab line, `visudo -cf` guard on the sudoers drop-in, ufw: default deny incoming, allow in on `tailscale0`, allow `41641/udp`, allow ssh (temporary, removed in A4), `tailscale up --auth-key="$TS_AUTH_KEY" --advertise-tags=tag:server` (key injected at create time, see A2)
- Docker and Tailscale apt repos are written in `runcmd`, not the `apt:` block: both publish per Ubuntu codename and a brand-new release may not be there yet, so the script probes for `$VERSION_CODENAME` and falls back to `noble`. cloud-init only runs once, a 404 here would leave a dead box.
- Line 1 must be exactly `#cloud-config`. ESLint's yaml comment-spacing rule rewrites it to `# cloud-config`, which silently disables the whole file, so `infra/cloud-init.yaml` is in `ignores` in `eslint.config.mjs`.

Prereq (one-time, manual): Tailscale admin console → Access controls → add `"tagOwners": {"tag:server": ["autogroup:admin"]}`. An auth key is optional, see A2.

- Verify locally: `cloud-init schema --config-file infra/cloud-init.yaml` (brew install cloud-init) passes.

### A2. `infra/provision.sh`

Goal: one command creates a ready box. Thin wrapper, no abstraction layer:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${HCLOUD_TOKEN:?}"  # or: doctl auth init
: "${TS_AUTH_KEY:?}"   # reusable tagged auth key from A1 prereq
envsubst '${TS_AUTH_KEY}' < "$(dirname "$0")/cloud-init.yaml" > /tmp/jamis-cloud-init.yaml
hcloud server create --name jamis-prod --type cx23 --location fsn1 \
  --image ubuntu-26.04 --ssh-key <your-key-name> --user-data-from-file /tmp/jamis-cloud-init.yaml
rm /tmp/jamis-cloud-init.yaml
hcloud server ip jamis-prod
```

Provider switch = swap the `hcloud` line for `doctl compute droplet create jamis-prod --size s-2vcpu-4gb --region nyc3 --image ubuntu-24-04-x64 --user-data-file ...` (comment in the script). ponytail: support the provider you use, document the alternative, don't build a provider abstraction.

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
# edit .env.prod: FIREWORKS_API_KEY, API_TOKEN (openssl rand -hex 32), DB passwords, TAILSCALE_IP=<from tailscale ip -4>
```

- Verify: `.env.prod` filled, `git log --oneline -1` shows HEAD.

### A4. Close public SSH

The plan originally deferred this until after the first deploy. Do it as soon as tailnet SSH is proven instead: everything after this point runs over the tailnet, so there is no reason to leave port 22 facing the internet while Track B is still being written.

```bash
ssh root@<tailscale-ip> 'ufw delete allow ssh && ufw reload'
```

- Verify: `ssh root@<public-ip>` times out (ufw drops rather than refuses); `ssh root@<tailscale-ip>` still works.
- If tailscaled ever dies on the box, the only way back in is Hetzner rescue mode. `tailscaled` is enabled at boot, so reboots are fine.

**Track A boundary smoke:** fresh box → `provision.sh` → A3 → A4 → API answers over tailnet with a valid token.

---

## Track B — Productionalization (repo changes)

Do B1-B4 locally, commit each; B5-B6 use the VPS.

### B1. Secrets plumbing

Goal: `.env.prod` ignored, template committed.
- `.gitignore` (root): add `.env.prod`.
- New `apps/agent/.env.prod.example`:

```
FIREWORKS_API_KEY=
API_TOKEN=            # openssl rand -hex 32
TUNNEL_TOKEN=         # from Cloudflare dashboard (B6)
TAILSCALE_IP=         # tailscale ip -4 on the VPS
POSTGRES_PASSWORD=
DATABASE_URL=postgresql://postgres:CHANGE_ME@postgres:5432/mastra
CLICKHOUSE_URL=http://clickhouse:8123
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=
```

- Verify: `git check-ignore apps/agent/.env.prod` exits 0.
- Commit: `chore: gitignore .env.prod and add prod env template`

### B2. Dockerfile + .dockerignore

Goal: self-contained prod image of the agent.
- `apps/agent/package.json`: build script → `"build": "mastra build --studio"` (ponytail: one-word change; `--studio` on a dev build is harmless).
- New `apps/agent/Dockerfile`:

```dockerfile
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/agent/package.json apps/agent/
RUN pnpm install --filter @jamis-mastra/agent... --frozen-lockfile
COPY apps/agent apps/agent
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm -F @jamis-mastra/agent build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/apps/agent/.mastra/output ./
USER node
CMD ["node", "index.mjs"]
```

- New root `.dockerignore`: `node_modules`, `**/node_modules`, `.mastra`, `**/.mastra`, `.env`, `.env.prod`, `.git`, `docs`.
- Verify locally: `docker build -f apps/agent/Dockerfile -t jamis-agent .` succeeds; `docker run --rm jamis-agent node --version` works.
- Commit: `feat(agent): two-stage prod Dockerfile with studio bundle`

### B3. Prod compose overlay

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
    depends_on: [postgres, clickhouse]   # ponytail: no healthchecks; restart policy covers cold-start races
    ports:
      - '${TAILSCALE_IP}:4111:4111'      # tailnet-only host exposure (Studio + direct API)
    restart: unless-stopped
    logging:
      driver: json-file
      options: { max-size: 10m, max-file: '3' }
  cloudflared:
    image: cloudflare/cloudflared
    command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}
    depends_on: [app]
    restart: unless-stopped
```

  (cloudflared reaches `http://app:4111` over the compose network; no host port needed for the tunnel. `!reset []` drops the dev `127.0.0.1` bindings entirely, defense in depth, two lines.)
- New `apps/agent/clickhouse/memory.xml`:

```xml
<clickhouse>
  <max_server_memory_usage>1500000000</max_server_memory_usage>
</clickhouse>
```

- Verify: `docker compose --env-file .env.prod.example -f docker-compose.yml -f docker-compose.prod.yml config` renders without errors.
- Commit: `feat(agent): prod compose overlay with app, cloudflared, CH memory cap`

### B4. SimpleAuth wiring

Goal: API requires bearer token everywhere it's served.
- `apps/agent/src/mastra/index.ts`:

```ts
import { SimpleAuth } from '@mastra/core/server';
// in the Mastra config:
server: {
  auth: new SimpleAuth({
    tokens: { [process.env.API_TOKEN!]: { id: 'admin', name: 'admin' } },
  }),
},
```

  No `public:` exceptions: Studio ships its token in `X-Playground-Access`, which SimpleAuth checks by default. Studio workflow: open Studio over tailnet → paste `API_TOKEN` in the access-token field.
- Add `API_TOKEN=` to `apps/agent/.env.example`.
- Verify locally: `mastra dev`, then `curl localhost:4111/api/agents` → 401; `curl -H "Authorization: Bearer $API_TOKEN" localhost:4111/api/agents` → agent JSON.
- Commit: `feat(agent): protect API with SimpleAuth bearer token`

### B5. `infra/deploy.sh` + first deploy

Goal: deploys are one non-interactive command from your Mac.
- New `infra/deploy.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
HOST="${JAMIS_HOST:?set JAMIS_HOST to the VPS tailscale IP or hostname}"
ssh "root@${HOST}" 'cd /root/jamis-mastra && git pull --ff-only && cd apps/agent && docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml up -d --build'
```

- Verify: run it, then `curl -H "Authorization: Bearer $API_TOKEN" http://$JAMIS_HOST:4111/api/agents` → agent JSON; `curl http://$JAMIS_HOST:4111/api/agents` (no token) → 401; Studio loads at `http://$JAMIS_HOST:4111` and works after entering the token.
- Commit: `feat(infra): provision + deploy scripts with cloud-init`

### B6. Cloudflare dashboard (no repo changes)

Goal: public hostname live behind Access.
1. Zero Trust → Networks → Tunnels → create remotely-managed tunnel → copy token into `.env.prod` as `TUNNEL_TOKEN` → recreate cloudflared (`up -d --force-recreate cloudflared`).
2. Tunnel → Public hostnames: `mastra-agent.jamis.xyz` → service `http://app:4111`. Only this hostname; no Studio routes.
3. Access → Applications → add application for `mastra-agent.jamis.xyz` with an allow policy (your email / IdP group).
- Verify (boundary smoke):
  - `curl https://mastra-agent.jamis.xyz/api/agents` → blocked by Access (302/403, never reaches origin).
  - Authenticated request (Access session + bearer token) → agent JSON.
  - Studio loads over tailnet IP only.

**Cut:** healthcheck conditions on `depends_on` (restart policy suffices), Watchtower/auto-updates, docker logging daemon config, fail2ban (no public SSH left to protect), Tailscale SSH (plain sshd over tailscale0 works), provider-abstraction layer in provision.sh, Terraform/Ansible. Add any of these when a concrete pain shows up.

## Open questions / follow-ups

1. Repo visibility: private → deploy key (A3); confirm before provisioning.
2. Access policy membership: who's allowed through Cloudflare Access (single email? IdP group? service tokens for programmatic callers?).
3. Backups: off-box `pg_dump` cron → object storage. Not scheduled.
4. `agent.jamis.xyz` cutover from v1 agent, separate plan.
5. Memory headroom: watch `docker stats` during first `up --build`; CX23 has 4GB, resize to CX33 (8GB, $8.99) if the build OOMs even with swap.
6. Docker bypasses ufw for published ports: safe today because nothing publishes on a public interface (`!reset []` + tailscale-IP binding). If a future port is ever published publicly, ufw alone won't block it, revisit then.
7. Tailscale auth key rotation: reusable keys live max 90 days. Note in password manager to regenerate; only needed when provisioning a new box, existing nodes stay connected.
8. Data migration when switching boxes: PG/ClickHouse volumes don't move by themselves. New box = fresh databases unless you pg_dump/restore. Acceptable (deferred with backups), call it out before any provider switch.
