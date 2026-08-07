# Jamis Mastra

Monorepo for the Jamis agent system, built on Mastra. `apps/agent` is the Mastra server hosting the agents; the same Docker stack (Postgres + ClickHouse) runs in dev and prod.

## Language

**Jamis**:
The master agent (to be built in `apps/agent`, `id: 'jamis'`). Also the Docker Compose project name and the VPS sudo user.
_Avoid_: master agent, main agent (use "Jamis")

**Public ingress**:
Cloudflare Tunnel exposing only the Mastra API at `mastra-agent.jamis.xyz`, fronted by Cloudflare Access. The only public path into production.
_Avoid_: public endpoint, external access

**Private ops**:
Everything reachable only over the Tailscale tailnet: SSH, Studio, direct Postgres/ClickHouse access.
_Avoid_: admin network, internal access

**Track A / Track B**:
Track A = VPS provisioning (Hetzner CPX21 EU, cloud-init + infra/provision.sh). Track B = productionalization (repo changes: Dockerfile, prod compose overlay, auth, infra/deploy.sh). See docs/plans/001-vps-production-setup.md.

**Disposable box**:
The VPS is cattle, not pets: any box is replaceable by re-running infra/provision.sh + one secrets step + infra/deploy.sh. No state lives outside Docker volumes and .env.prod.
_Avoid_: snowflake server, pet server
