#!/usr/bin/env bash
# Create the Jamis prod box. See docs/plans/001-vps-production-setup.md (A2).
#
#   HCLOUD_TOKEN=... ./infra/provision.sh
#
# TS_AUTH_KEY is optional. Leaving it unset keeps the key out of Hetzner's user-data,
# which the console and API expose for the life of the box. The tradeoff is one manual
# step afterwards:
#   ssh -t root@<ip> 'tailscale up --advertise-tags=tag:server'
#
# Needs: hcloud CLI (brew install hcloud), gettext for envsubst (brew install gettext).
set -euo pipefail

: "${HCLOUD_TOKEN:?set HCLOUD_TOKEN (Hetzner Cloud API token, Read & Write)}"
TS_AUTH_KEY="${TS_AUTH_KEY:-}"
export TS_AUTH_KEY

SERVER_NAME="${SERVER_NAME:-jamis-prod}"
SERVER_TYPE="${SERVER_TYPE:-cx23}"
LOCATION="${LOCATION:-fsn1}"
IMAGE="${IMAGE:-ubuntu-26.04}"
HCLOUD_SSH_KEY="${HCLOUD_SSH_KEY:-abdirahman.haji.13@gmail.com}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Not `mktemp -t`: BSD treats the argument as a prefix, GNU demands a template.
user_data="$(mktemp "${TMPDIR:-/tmp}/jamis-cloud-init.XXXXXX")"
trap 'rm -f "$user_data"' EXIT

# Only TS_AUTH_KEY is substituted; the shell vars inside runcmd survive untouched.
envsubst '${TS_AUTH_KEY}' < "$here/cloud-init.yaml" > "$user_data"

hcloud server create \
  --name "$SERVER_NAME" \
  --type "$SERVER_TYPE" \
  --location "$LOCATION" \
  --image "$IMAGE" \
  --ssh-key "$HCLOUD_SSH_KEY" \
  --user-data-from-file "$user_data"

hcloud server ip "$SERVER_NAME"

# DigitalOcean equivalent, if the provider ever changes:
#   doctl compute droplet create jamis-prod --size s-2vcpu-4gb --region nyc3 \
#     --image ubuntu-24-04-x64 --ssh-keys <fingerprint> --user-data-file "$user_data"
