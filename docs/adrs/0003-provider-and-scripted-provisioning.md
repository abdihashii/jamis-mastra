# Provider: Hetzner CX23 in Falkenstein, provisioning by script

The production VPS is a Hetzner Cloud **CX23** (2 vCPU, 4GB RAM, 40GB SSD, **$6.49/mo**) in **Falkenstein, Germany (fsn1)**, running Ubuntu 26.04.

## Why this configuration

- **Provider: Hetzner over DigitalOcean.** Same 4GB of RAM at $6.49/mo instead of $24/mo (DO Basic Regular 4GB, checked on digitalocean.com/pricing). DO's upsides (US regions, nicer dashboard, an official Mastra droplet guide) are not worth about $210/yr more for a personal agent with one operator.
- **Region: EU (Falkenstein) over US.** The latency cost is small for this workload. Cloudflare ends public TLS near the caller, LLM generation time dwarfs network time, and deploys are one non-interactive SSH command. Falkenstein over Helsinki or Nuremberg: slightly closer to the US, though all three are nearly equal. Accepted costs: about 100-130ms round trip for SSH and Studio, about +100ms per Fireworks LLM call, EU data residency.
- **Size: 4GB RAM.** Set by the memory floor of the stack. ClickHouse's own small-server guidance puts the minimum at about 4GB of system RAM, and Mastra builds can spike 2-4GB of heap on the box (covered by a 4GB swapfile). Steady state is Postgres (~300MB) plus capped ClickHouse (~1.5GB) plus Node (~500MB). All 2GB options (CPX12, CPX11, DO $12/$18) were rejected as too small. Escape hatch: CX33 (8GB, $8.99/mo), resizable in place.
- **Line: CX (cost optimized) over CPX (performance).** CPX has newer AMD chips and faster disks. This workload cannot feel the difference; its limit is RAM, not CPU or disk speed.

## Provisioning

One cloud-init file plus two small shell scripts in `infra/`. `provision.sh` wraps `hcloud` server create with the cloud-init file (a doctl alternative sits in a comment). `deploy.sh` wraps the SSH git-pull-and-compose-up deploy. We chose this over Terraform or Ansible: one box, one operator, and the scripts make the box replaceable. Switching providers or upgrading size means re-running the script, not migrating anything.

Docker comes from its official apt repository, not the get.docker.com script (that script says itself it is not for production). The repo line is written in `runcmd` rather than cloud-init's `apt:` block, because Docker and Tailscale publish per Ubuntu codename and a brand-new release may not be there on day one. The script probes and falls back to `noble`, since cloud-init runs once and a 404 would leave a dead box.

## Host accounts

`root` is the operator account and the only privileged one. It carries the operator's SSH key, accepts keys only (`PermitRootLogin prohibit-password`, password auth off), and after stage A4 is reachable only over the tailnet. `deploy.sh` connects as root and the repo lives at `/root/jamis-mastra`.

`jamis` is the agent's host account, unprivileged on purpose. No SSH key until the agent actually needs one, `lock_passwd: true`, and deliberately **not** in the `docker` group: socket access to the Docker daemon is root, so that group is not a lesser privilege. What it does get is enough to look at the box and change nothing: the `systemd-journal` group (journal reads with no sudo at all) and a sudoers allowlist that pins arguments, so `docker ps`, `ps -a`, `stats --no-stream`, `compose ls`, and `logs *` work while `docker run` does not. `docker inspect` is excluded because it prints container env vars, which is where the secrets are.

Why split at all when the agent runs in a container as `USER node` with no host mount: the container is the real boundary today, and the account matters the day the agent gets any way to run commands on the host. cloud-init runs once, so the split is cheaper to make now than to retrofit.

## Consequences

- Volumes do not move between boxes. Switching providers means fresh databases unless you pg_dump first (backups are a separate deferred follow-up).
- The Tailscale auth key used by cloud-init is a reusable tagged key (`tag:server`), stored outside git. It expires after 90 days and only matters when creating a new box.
