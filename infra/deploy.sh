#!/usr/bin/env bash
# Deploy to the Jamis prod box. See docs/plans/001-vps-production-setup.md (B5).
#
#   JAMIS_HOST=<tailscale ip or hostname> ./infra/deploy.sh
#
# Connects as root, the operator account. Builds on the box from git.
# Assumes stage A3 was done (repo cloned, .env.prod filled).
set -euo pipefail

HOST="${JAMIS_HOST:?set JAMIS_HOST to the VPS tailscale IP or hostname}"
BRANCH="${JAMIS_BRANCH:-main}"

# Quoted heredoc, branch passed as an argument: the script body is not expanded
# by the local shell. The branch still reaches the remote shell as "$1", so keep
# it quoted there.
ssh "root@${HOST}" bash -euo pipefail -s "$BRANCH" <<'EOF'
branch="$1"
cd /root/jamis-mastra
git fetch origin
git checkout "$branch"
git pull --ff-only

# .env.prod moved from apps/agent/ to the repo root when the workspace
# flattened. A box deployed before that move still has it at the old path.
if [ ! -f .env.prod ]; then
  echo "Missing .env.prod at repo root. Run: mv apps/agent/.env.prod .env.prod" >&2
  exit 1
fi

# Validate with the same Intl implementation the app uses, before replacing the
# healthy container. Only the short-lived validator receives the env file.
docker run --rm --env-file .env.prod oven/bun:1.3.14-alpine bun -e '
const zone = process.env.OPERATOR_TIMEZONE?.trim();
const correction = "Set OPERATOR_TIMEZONE in .env.prod to an IANA time zone such as America/Chicago.";
if (!zone) {
  console.error(`Missing OPERATOR_TIMEZONE. ${correction}`);
  process.exit(1);
}
let valid = !/^[+-]/.test(zone);
try {
  new Intl.DateTimeFormat("en-US", { timeZone: zone });
} catch {
  valid = false;
}
if (!valid) {
  console.error(`Invalid OPERATOR_TIMEZONE: "${zone}". ${correction}`);
  process.exit(1);
}
'

# Only the fixed probe can read the host and Docker daemon. The app receives
# its group-readable Unix socket, never the Docker socket or a host shell.
install -d -m 0755 /usr/local/libexec
install -m 0755 infra/host_evidence_probe.py /usr/local/libexec/jamis-host-evidence-probe
install -m 0644 infra/jamis-evidence.socket infra/jamis-evidence@.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now jamis-evidence.socket
systemctl restart jamis-evidence.socket
export JAMIS_SOCKET_GID="$(id -g jamis)"

# No TAILSCALE_IP guard: the app binds 127.0.0.1 and tailscale serve publishes it
# to the tailnet, so there is no variable left whose value could expose the box.
docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml ps
EOF
