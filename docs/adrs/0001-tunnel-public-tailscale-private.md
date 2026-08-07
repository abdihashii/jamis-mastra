# Public ingress via Cloudflare Tunnel, private ops via Tailscale

The production VPS runs the Jamis Mastra stack in Docker. Two network layers with distinct roles: Cloudflare Tunnel is the only public ingress and exposes only the Mastra API (TLS terminates at Cloudflare's edge, no ports open on the VPS). Tailscale is the private ops layer: SSH, Mastra Studio, and direct Postgres/ClickHouse access are reachable only on the tailnet.

Chosen over nginx + Let's Encrypt + open ports (more moving parts, requires firewall discipline) and over Tailscale-only (no public endpoint for external clients). Consequence: no nginx container exists anywhere in the stack; VPS firewall can deny all inbound.
