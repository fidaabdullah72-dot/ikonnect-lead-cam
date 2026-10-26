#!/usr/bin/env bash
# Deploy or update BatWos on two small servers (Oracle Always Free AMD micros, 1 GB each):
#   deploy/oracle/deploy-micro.sh <web-server-ip> <engine-server-ip> [ssh-key-file]
# The micros are too small to build the images, so this computer builds them and
# uploads them. Server 1 runs the dashboard, HTTPS and the Google Maps search
# (scraper-only engine with Chromium); server 2 runs the engine (WhatsApp, campaigns,
# inbox, automations) without Chromium. Run deploy/oracle/server-setup.sh once on
# each server first (deploy.sh does it for the single-server setup).
set -euo pipefail

WEB="${1:?Usage: deploy-micro.sh <web-ip> <engine-ip> [ssh-key-file]}"
ENGINE="${2:?Usage: deploy-micro.sh <web-ip> <engine-ip> [ssh-key-file]}"
KEY="${3:-$HOME/.ssh/batsols-oracle.key}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/oracle/.env"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)
COMPOSE='sudo docker compose -f deploy/oracle/docker-compose.yml --env-file deploy/oracle/.env'

[ -f "$ENV_FILE" ] || { echo "Missing deploy/oracle/.env"; exit 1; }
set -a; . "$ENV_FILE"; set +a

echo "→ Building images"
cd "$ROOT"
docker build -q -f crm-dashboard/Dockerfile \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
  --build-arg NEXT_PUBLIC_APP_URL="https://$DOMAIN" \
  -t batsols-web:latest . >/dev/null
docker build -q -f engine/Dockerfile.slim -t batsols-engine:latest . >/dev/null
docker build -q -f engine/Dockerfile.slim --build-arg WITH_CHROMIUM=1 -t batsols-scraper:latest . >/dev/null

ship() { # ship <host> <image> — skipped when the server already has this exact image
  local id remote
  id=$(docker image inspect -f '{{.Id}}' "$2")
  remote=$(ssh "${SSH_OPTS[@]}" "ubuntu@$1" "sudo docker image inspect -f '{{.Id}}' $2 2>/dev/null || true")
  if [ "$id" = "$remote" ]; then echo "→ $2 already on $1"; return; fi
  echo "→ Uploading $2 to $1"
  docker save "$2" | gzip -1 | ssh "${SSH_OPTS[@]}" "ubuntu@$1" 'gunzip | sudo docker load -q'
}
config() { # config <host> [extra env line]
  ssh "${SSH_OPTS[@]}" "ubuntu@$1" 'mkdir -p batsols/deploy/oracle'
  scp "${SSH_OPTS[@]}" -q "$ROOT/deploy/oracle/docker-compose.yml" "$ROOT/deploy/oracle/Caddyfile" "ubuntu@$1:batsols/deploy/oracle/"
  { cat "$ENV_FILE"; if [ -n "${2:-}" ]; then echo "$2"; fi; } | ssh "${SSH_OPTS[@]}" "ubuntu@$1" 'umask 077 && cat > batsols/deploy/oracle/.env'
}

ship "$WEB" batsols-web:latest
ship "$WEB" batsols-scraper:latest
config "$WEB"
ssh "${SSH_OPTS[@]}" "ubuntu@$WEB" "cd batsols && $COMPOSE up -d --no-build web caddy scraper && sudo docker image prune -f >/dev/null"

ship "$ENGINE" batsols-engine:latest
config "$ENGINE" 'SCRAPER_BROWSER=false'
ssh "${SSH_OPTS[@]}" "ubuntu@$ENGINE" "cd batsols && $COMPOSE up -d --no-build engine && sudo docker image prune -f >/dev/null"

echo "✓ Deployed — https://$DOMAIN"
