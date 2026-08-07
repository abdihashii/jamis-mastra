# Provider: Hetzner CX23 in Falkenstein, provisioning via cloud-init + thin scripts

The production VPS is a Hetzner Cloud **CX23** (2 vCPU / 4GB RAM / 40GB SSD / 20TB traffic, **$6.49/mo**, cost-optimized shared-vCPU line) in **Falkenstein, Germany (fsn1)**, Ubuntu 24.04.

## Why this configuration

- **Provider: Hetzner over DigitalOcean.** Same 4GB RAM at $6.49/mo vs $24/mo (DO Basic Regular 4GB, verified against digitalocean.com/pricing). DO's advantages (US regions, nicer dashboard, an official Mastra droplet guide) don't justify ~$210/yr more for a single-operator personal agent.
- **Region: EU (Falkenstein) over US.** Latency costs are negligible for this workload: Cloudflare's edge terminates public TLS near clients, LLM generation time dominates API responses, and deploys are non-interactive SSH one-liners. Falkenstein over Helsinki/Nuremberg: marginally closest major EU site to the US; the difference between the three is trivial. Accepted costs: ~100-130ms RTT for interactive SSH/Studio, +~100ms per Fireworks LLM call, EU data residency.
- **Size: 4GB RAM.** Set by the stack's memory floor: ClickHouse's own small-server guidance says ~4GB system RAM is minimum viable, and Mastra builds can spike 2-4GB heap on-box (covered by a 4GB swapfile). Steady state is PG (~300MB) + capped ClickHouse (~1.5GB) + Node (~500MB). 2GB options (CPX12, CPX11, DO $12/$18) were rejected as below the floor. Escape hatch: CX33 (8GB, $8.99/mo), resizable in place.
- **Line: CX (cost-optimized) over CPX (performance).** CPX's newer AMD EPYC chips and NVMe are inaudible for a bursty personal agent whose bottleneck is RAM capacity, not CPU/disk speed.

## Provisioning

A cloud-init user-data file plus two thin shell scripts in `infra/` (`provision.sh` wraps `hcloud` create with the user-data, doctl alternative in a comment; `deploy.sh` wraps the SSH git-pull-and-compose-up deploy). Chosen over Terraform/Ansible: one box, one operator, and scripts make the box disposable; switching providers or resizing means re-running provision, not migrating. Docker comes from its official apt repository, not the get.docker.com convenience script (self-declared not for production).

## Consequences

- Volumes don't migrate between boxes. A provider switch means fresh databases unless you pg_dump first (backups are a separate deferred follow-up).
- The Tailscale auth key used by cloud-init is a reusable tagged key (`tag:server`), stored outside git; it expires after 90 days and only matters when provisioning a new box.
