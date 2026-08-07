# Jamis Mastra

Monorepo for the Jamis agent system, built on Mastra. `apps/agent` is the Mastra server hosting the agents. The same Docker stack (Postgres + ClickHouse) runs in dev and prod.

## Language

**Jamis**:
The master agent (to be built in `apps/agent`, `id: 'jamis'`). Also the Docker Compose project name, and the name of the agent's unprivileged account on the VPS.
_Avoid_: master agent, main agent (use "Jamis")

**Operator**:
You, logging in as `root` over the tailnet. The only account with privilege on the box. The `jamis` account is the agent's, and holds read-only inspection rights, never `sudo` in general and never the `docker` group.
_Avoid_: admin user, deploy user

**Public ingress**:
Cloudflare Tunnel exposing only the Mastra API at `mastra-agent.jamis.xyz`, with Cloudflare Access in front. The only public path into production.
_Avoid_: public endpoint, external access

**Private ops**:
Everything reachable only over the Tailscale tailnet: SSH, Studio, direct Postgres/ClickHouse access.
_Avoid_: admin network, internal access

**Track A / Track B**:
Track A is VPS provisioning (Hetzner CX23 in Falkenstein, cloud-init plus infra/provision.sh). Track B is productionalization (repo changes: Dockerfile, prod compose overlay, auth, infra/deploy.sh). See docs/plans/001-vps-production-setup.md.

**Disposable box**:
The VPS is replaceable. A new box comes from re-running infra/provision.sh, one secrets step, and infra/deploy.sh. All state lives in Docker volumes and .env.prod.
_Avoid_: snowflake server, pet server
