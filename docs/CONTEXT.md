# Jamis Mastra

Single-package repo for the Jamis agent system, built on Mastra. `src` is the Mastra server hosting the agents.

Docker Compose runs Postgres and ClickHouse in both dev and prod. In dev that is all it runs: the agent itself runs on the host with `pnpm dev`, pointed at the two containers over `localhost`. Prod adds `docker-compose.prod.yml`, which puts the agent in the stack as the `app` service alongside `cloudflared` and drops the databases' host port bindings.

## Language

**Jamis**:
Just A Mostly Intelligent System. The channel-facing personal agent (`id: 'jamis'`). A personal agent to text like a person, that keeps conversational continuity across days, projects, and contexts until the operator starts a new DM session, and over time takes work off his plate. The model is JARVIS to Tony Stark, and that sets the register: dry and understated rather than eager, says the inconvenient thing plainly, and admits what it does not know. "Mostly Intelligent" is the same point in the name. Also the Docker Compose project name, and the name of the agent's unprivileged account on the VPS.
_Avoid_: master agent, main agent (use "Jamis")

**Subagent**:
An internal agent that accepts bounded delegated work from Jamis. Jamis owns the operator conversation and turns a subagent result into the final response.

**Online research**:
Jamis's capability to discover and read relevant public webpages or specialized research records from a question, then answer the operator with traceable sources. It excludes whole-site crawling and interactive browser work.
_Avoid_: web browsing, web search

**Research candidate**:
A public webpage or specialized research record identified during Online research that may contain relevant evidence. Discovery descriptions, titles, identifiers, and unread metadata alone do not verify a claim.
_Avoid_: verified source, evidence

**Research source**:
A public webpage, research record, or passage actually read during Online research whose retrieved content supports a cited finding and is traceable to its original source URL or identifier.
_Avoid_: search result, unread source

**Abstract-only evidence**:
A retrieved paper abstract that supports only findings explicitly stated in that abstract. It is labeled abstract-only and does not establish that the paper's full text was read.
_Avoid_: full-text evidence, paper read

**Personal-accounts agent**:
The internal subagent that owns tool integrations with the operator's personal accounts (first: Gmail over the Google API; second: Calendar). Jamis delegates personal-account requests to it; its result is evidence for Jamis's final reply, not a channel reply itself. One delegation boundary for the whole personal-account class, not one subagent per account provider.
_Avoid_: email agent, gmail subagent, google agent

**Google credential**:
The operator's Google OAuth desktop-app credential (access and refresh tokens, expiry) stored in a 0600 gitignored JSON file in `data/`. Captured headless by a `login:google` script over SSH using a loopback redirect reached through `ssh -L`; a missing or dead credential is a hard failure until re-login, with no fallback. Gmail-scoped refresh tokens die if the operator changes their Google account password. See [ADR 0015](adrs/0015-personal-accounts-agent.md).
_Avoid_: Google API key, Gmail login

**Verification-required claim**:
An external claim about current or changeable facts, numbers, dates, quotes, named-person or organization status, product or API behavior, high-stakes matters, or a recommendation that depends on such facts. Jamis states it only when supported by evidence; otherwise, Jamis says it could not verify enough to give a factual answer.
_Avoid_: uncertain claim

**Credible source**:
An authoritative primary source, such as official documentation, a government or standards body, original research, a direct company statement, or an original dataset. When no primary source is available, evidence requires two independent established secondary sources; anonymous blogs, content farms, forums, and social posts are leads only unless the post itself is being verified.
_Avoid_: top search result, popular source

**Research subagent**:
The internal subagent through which Jamis performs online research and receives sourced evidence. Only Jamis delegates to it; Jamis owns the operator conversation and final answer.
_Avoid_: web agent, browser agent

**Check**:
A plain question Jamis asks when missing information or outcome-changing ambiguity prevents a useful answer. The operator's next message supplies the needed context, and Jamis may ask again while it remains unclear. On the current Sendblue shared-line channel, a check is plain text rather than a structured prompt.
_Avoid_: approval (implies a button card)

**Operator**:
You, logging in as `root` over the tailnet. The only account with privilege on the box. The `jamis` account is the agent's, and holds read-only inspection rights, never `sudo` in general and never the `docker` group.
_Avoid_: admin user, deploy user

**Operator time zone**:
The operator's explicitly confirmed civil time zone, used to interpret date references and present times to the operator. It can come from system setup or conversation and does not represent or prove the operator's live physical location.
_Avoid_: app timezone (ambiguous), detected location

**Channel**:
A messaging platform the operator reaches an agent through, instead of Studio. iMessage over Sendblue is the first one.
_Avoid_: integration, connector, bridge

**Jamis DM session**:
A bounded conversation with Jamis inside the operator's unchanged 1:1 iMessage conversation. Sessions keep the same operator identity (`resourceId`) but have separate Mastra threads (`threadId`), with no conversational memory shared between sessions.
_Avoid_: iMessage conversation, operator identity, agent run

**Request intake**:
The Channel's acceptance of an Operator message for Jamis. It does not imply a completed reply.
_Avoid_: successful conversation

**Reply acceptance**:
Sendblue's acceptance of a reply sent by Jamis. It does not prove delivery to the Operator's handset.
_Avoid_: reply delivery, delivered reply

**Application incident**:
A specific failed or degraded execution within the Jamis application boundary, such as an agent, workflow, scheduled job, application storage operation, Channel intake, or Reply acceptance. It excludes failures of the host and deployment infrastructure.
_Avoid_: monitoring event, VPS incident, server incident

**Observability**:
The capability to infer Jamis's internal state and investigate why behavior occurred by correlating Telemetry across components.
_Avoid_: telemetry, monitoring, incident triage

**Telemetry**:
The metrics, events, logs, traces, and other recorded signals produced by Jamis and its Deployment. Telemetry is evidence used by Monitoring, Observability, and Incident triage.
_Avoid_: observability, monitoring data

**Operational snapshot**:
An operator-requested, read-only account of what happened across Jamis and its Deployment and what remains unknown. It preserves narrow source-specific claims, including confirmed operation and gaps for the same component, without suggesting or taking an intervention.
_Avoid_: dashboard, alert

**Monitoring**:
The collection, processing, aggregation, and presentation of system data used to judge service behavior. An Operational snapshot is Jamis's on-demand view of that evidence.
_Avoid_: observability, incident triage

**Monitoring finding**:
A source-proven condition or recent failed outcome that needs the Operator's attention. A past failed outcome does not by itself establish a current outage.
_Avoid_: outage, alert

**Recovered event**:
A recent failure whose owning source proves that the same operation or state later reached a successful outcome. A separate later success does not prove recovery.
_Avoid_: later success, assumed recovery

**Incident triage**:
The initial narrowing and classification of an incident: identify the affected component, scope, severity, relevant evidence, and next investigative path. Triage may report a cause only when the evidence proves it.
_Avoid_: monitoring, root-cause analysis, remediation

**Incident investigation**:
The evidence-driven work after triage that explains why and how an incident occurred. It may establish a root cause when the available Observability supports one.
_Avoid_: incident triage, monitoring

**Deployment**:
The complete environment running Jamis and its supporting services, independent of the current hosting provider or machine shape.
_Avoid_: VPS (too implementation-specific), server

**Deployment incident**:
A specific failure anywhere within the Deployment, including the application, host, runtime services, data services, or network path.
_Avoid_: Application incident

**Codex credential**:
The operator's ChatGPT/Codex subscription OAuth credential (access and refresh tokens, expiry, account id) stored in a 0600 JSON file and used by the `openai-codex` gateway. A missing credential is a hard failure until re-login; there is no API-key fallback. See [ADR 0014](adrs/0014-openai-codex-model-auth.md).
_Avoid_: API key, ChatGPT login

**Trace export boundary**:
Channel render context and adapter configuration are runtime-only and must never be exported in traces. Channel credentials must never enter exported records. See [ADR 0013](adrs/0013-channel-render-context-trace-boundary.md).
_Avoid_: trace context (ambiguous)

**Sendblue line**:
The phone number Sendblue assigns to the account, which an agent receives on and sends from.
_Avoid_: the number, the bot number

**Operator number**:
The operator's own handset. The only number whose channel messages may invoke an agent.
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
