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

# Quoted heredoc, branch passed as an argument: nothing from the local shell is
# interpolated into a command that runs as root on the box.
ssh "root@${HOST}" bash -euo pipefail -s "$BRANCH" <<'EOF'
branch="$1"
cd /root/jamis-mastra
git fetch origin
git checkout "$branch"
git pull --ff-only
cd apps/agent

# An empty TAILSCALE_IP turns the ':4111:4111' binding into '4111:4111', which docker
# publishes on every interface, public IP included. Docker's iptables rules sit in front
# of ufw, so 'default deny incoming' would not catch it. Fail closed instead.
if ! grep -qE '^TAILSCALE_IP=100\.' .env.prod; then
  echo 'refusing to deploy: TAILSCALE_IP in .env.prod is not a 100.x tailnet address' >&2
  exit 1
fi

docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
EOF
