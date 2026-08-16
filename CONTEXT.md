# Jamis Mastra

Single-package repo for the Jamis agent system, built on Mastra. `src` is the Mastra server hosting the agents.

Docker Compose runs Postgres and ClickHouse in both dev and prod. In dev that is all it runs: the agent itself runs on the host with `pnpm dev`, pointed at the two containers over `localhost`. Prod adds `docker-compose.prod.yml`, which puts the agent in the stack as the `app` service alongside `cloudflared` and drops the databases' host port bindings.

## Language

**Jamis**:
Just A Mostly Intelligent System. The master agent (to be built in `src`, `id: 'jamis'`). A personal agent to text like a person, that remembers the operator across days, projects, and contexts rather than restarting each session, and over time takes work off his plate. The model is JARVIS to Tony Stark, and that sets the register: dry and understated rather than eager, says the inconvenient thing plainly, and admits what it does not know. "Mostly Intelligent" is the same point in the name. Also the Docker Compose project name, and the name of the agent's unprivileged account on the VPS.
_Avoid_: master agent, main agent (use "Jamis")

**Operator**:
You, logging in as `root` over the tailnet. The only account with privilege on the box. The `jamis` account is the agent's, and holds read-only inspection rights, never `sudo` in general and never the `docker` group.
_Avoid_: admin user, deploy user

**Channel**:
A messaging platform the operator reaches an agent through, instead of Studio. iMessage over Sendblue is the first one.
_Avoid_: integration, connector, bridge

**Sendblue line**:
The phone number Sendblue assigns to the account, which an agent receives on and sends from.
_Avoid_: the number, the bot number

**Operator number**:
The operator's own handset. The only number allowed to reach an agent over a channel; anything else is dropped without a reply.
_Avoid_: the number, my phone, the whitelist number

**Public ingress**:
Cloudflare Tunnel exposing only the Mastra API at `mastra-agent.jamis.xyz`, with Cloudflare Access in front of everything except channel webhooks, which the messaging platform has to reach unauthenticated. The only public path into production.
_Avoid_: public endpoint, external access

**Private ops**:
Everything reachable only over the Tailscale tailnet: SSH, Studio, direct Postgres/ClickHouse access.
_Avoid_: admin network, internal access

**Runtime**:
Bun. What executes JavaScript, in dev and in the container. Pinned in the `app` service and in the `package.json` scripts, which all run through `bun --bun`. Node still appears throughout (the Mac's own install, `node:*` imports, `@types/node`) and is named directly when meant.
_Avoid_: engine, JS runtime

**Package manager**:
Bun. What resolves and installs dependencies. Not the runtime, even though the same binary does both.
_Avoid_: build tool

**Track A / Track B**:
Track A is VPS provisioning (Hetzner CX23 in Falkenstein, cloud-init plus infra/provision.sh). Track B is making the agent production-ready (repo changes: Dockerfile, prod compose overlay, auth, infra/deploy.sh). See docs/plans/001-vps-production-setup.md.

**Disposable box**:
The VPS is replaceable. A new box comes from re-running infra/provision.sh, one secrets step, and infra/deploy.sh. All state lives in Docker volumes and .env.prod.
_Avoid_: snowflake server, pet server
