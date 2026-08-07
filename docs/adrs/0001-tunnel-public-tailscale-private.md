# Public access via Cloudflare Tunnel, private access via Tailscale

The production VPS runs the Jamis stack in Docker. Two network layers with separate jobs. Cloudflare Tunnel is the only way in from the public internet, and it exposes only the Mastra API. TLS ends at Cloudflare, so no ports are open on the VPS. Tailscale is the private layer for us: SSH, Mastra Studio, and direct Postgres/ClickHouse access only work on the tailnet.

We chose this over nginx plus Let's Encrypt plus open ports (more parts to run, more firewall rules to get right) and over Tailscale alone (no public endpoint for outside clients). Result: no nginx anywhere, and the VPS firewall can block all inbound traffic.
