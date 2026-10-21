#!/usr/bin/env bash
# Fast code-only update for the two micro servers (see deploy-micro.sh):
#   deploy/oracle/deploy-patch.sh <web-server-ip> <engine-server-ip> [ssh-key-file]
# Ships just the engine bundle and the web app's build output (tens of MB) and layers
# them onto the images already on the servers, instead of re-uploading whole images
# (GBs). Use deploy-micro.sh when dependencies or Dockerfiles change.
# SKIP_WEB=1 updates only the engine + scraper.
set -euo pipefail

WEB="${1:?Usage: deploy-patch.sh <web-ip> <engine-ip> [ssh-key-file]}"
ENGINE="${2:?Usage: deploy-patch.sh <web-ip> <engine-ip> [ssh-key-file]}"
KEY="${3:-$HOME/.ssh/batsols-oracle.key}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/oracle/.env"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ConnectTimeout=30)
COMPOSE='sudo docker compose -f deploy/oracle/docker-compose.yml --env-file deploy/oracle/.env'

[ -f "$ENV_FILE" ] || { echo "Missing deploy/oracle/.env"; exit 1; }
set -a; . "$ENV_FILE"; set +a
cd "$ROOT"

echo "→ Building"
npm run build -w @batsols/engine >/dev/null
if [ "${SKIP_WEB:-}" != 1 ]; then
  docker build -q -f crm-dashboard/Dockerfile \
    --build-arg NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL" \
    --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
    --build-arg NEXT_PUBLIC_APP_URL="https://$DOMAIN" \
    -t batsols-web:latest . >/dev/null
fi

P=$(mktemp -d)
trap 'rm -rf "$P"' EXIT
cp -R engine/dist "$P/dist"
printf 'FROM batsols-engine:latest\nCOPY dist /app/engine/dist\n' > "$P/Dockerfile.engine"
printf 'FROM batsols-scraper:latest\nCOPY dist /app/engine/dist\n' > "$P/Dockerfile.scraper"
files=(dist Dockerfile.scraper)
if [ "${SKIP_WEB:-}" != 1 ]; then
  cid=$(docker create batsols-web:latest)
  docker cp "$cid:/app/crm-dashboard/.next" "$P/next"
  docker rm "$cid" >/dev/null
  rm -rf "$P/next/cache"
  printf 'FROM batsols-web:latest\nUSER root\nRUN rm -rf /app/crm-dashboard/.next\nCOPY --chown=node:node next /app/crm-dashboard/.next\nUSER node\n' > "$P/Dockerfile.web"
  files+=(next Dockerfile.web)
fi

for host in "$ENGINE" "$WEB"; do # keep the compose file and Caddyfile in sync (not .env)
  scp "${SSH_OPTS[@]}" -q deploy/oracle/docker-compose.yml deploy/oracle/Caddyfile "ubuntu@$host:batsols/deploy/oracle/"
done

echo "→ Engine server ($ENGINE)"
tar -C "$P" -czf - dist Dockerfile.engine | ssh "${SSH_OPTS[@]}" "ubuntu@$ENGINE" \
  "rm -rf patch && mkdir patch && tar -C patch -xzf - && cd patch && sudo docker build -q -f Dockerfile.engine -t batsols-engine:latest . >/dev/null && cd ~/batsols && $COMPOSE up -d --no-build engine && sudo docker image prune -f >/dev/null"

echo "→ Web server ($WEB)"
build_web='true'
services='scraper'
if [ "${SKIP_WEB:-}" != 1 ]; then
  build_web='sudo docker build -q -f Dockerfile.web -t batsols-web:latest . >/dev/null'
  services='web scraper'
fi
tar -C "$P" -czf - "${files[@]}" | ssh "${SSH_OPTS[@]}" "ubuntu@$WEB" \
  "rm -rf patch && mkdir patch && tar -C patch -xzf - && cd patch && sudo docker build -q -f Dockerfile.scraper -t batsols-scraper:latest . >/dev/null && $build_web && cd ~/batsols && $COMPOSE --profile scraper up -d --no-build $services && sudo docker image prune -f >/dev/null"

echo "✓ Patched — https://$DOMAIN"
