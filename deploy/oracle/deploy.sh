#!/usr/bin/env bash
# Deploy or update BatWos on the server, from this computer.
#   deploy/oracle/deploy.sh <server-ip> [ssh-key-file]
# First run installs Docker; every run uploads the code, rebuilds and restarts.
# WhatsApp sessions live in the database, so numbers reconnect by themselves.
set -euo pipefail

HOST="${1:?Usage: deploy/oracle/deploy.sh <server-ip> [ssh-key-file]}"
KEY="${2:-$HOME/.ssh/batsols-oracle.key}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="ubuntu@$HOST"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)

[ -f "$KEY" ] || { echo "SSH key not found: $KEY"; exit 1; }
[ -f "$ROOT/deploy/oracle/.env" ] || { echo "Missing deploy/oracle/.env — copy deploy/oracle/.env.example and fill it in"; exit 1; }

echo "→ Preparing server"
ssh "${SSH_OPTS[@]}" "$TARGET" 'bash -s' < "$ROOT/deploy/oracle/server-setup.sh"

echo "→ Uploading code"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude node_modules --exclude .next --exclude dist --exclude .git \
  --exclude '.env' --exclude '.env.*' --exclude '*.docx' --exclude 'BatWos-Supabase-Schema.sql' \
  --exclude legacy --exclude server --exclude 'Whatsapp Automation' \
  --exclude 'supabase/.temp' --exclude 'supabase/.branches' --exclude .DS_Store \
  "$ROOT/" "$TARGET:batsols/"
scp "${SSH_OPTS[@]}" -q "$ROOT/deploy/oracle/.env" "$TARGET:batsols/deploy/oracle/.env"

echo "→ Building and starting (first time takes ~5–10 minutes)"
ssh "${SSH_OPTS[@]}" "$TARGET" 'cd batsols && sudo docker compose -f deploy/oracle/docker-compose.yml --env-file deploy/oracle/.env up -d --build --remove-orphans && sudo docker image prune -f >/dev/null'

DOMAIN=$(grep -E '^DOMAIN=' "$ROOT/deploy/oracle/.env" | cut -d= -f2-)
echo "✓ Deployed — https://$DOMAIN"
