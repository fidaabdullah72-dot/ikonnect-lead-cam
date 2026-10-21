# BatSols web app (dashboard + API routes). Build from the repo root:
#   docker build -f crm-dashboard/Dockerfile --build-arg NEXT_PUBLIC_SUPABASE_URL=… .
# NEXT_PUBLIC_* values are baked into the browser bundle at build time.
FROM node:22-bookworm-slim

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# Install only the web + shared workspaces (better layer caching).
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY crm-dashboard/package.json crm-dashboard/
RUN npm ci --workspace=crm-dashboard --workspace=@batsols/shared --include-workspace-root=false --no-audit --no-fund

COPY packages/shared packages/shared
COPY crm-dashboard crm-dashboard

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
RUN npm run build -w crm-dashboard && chown -R node:node crm-dashboard/.next

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
WORKDIR /app/crm-dashboard
# npm workspaces install `next` in the root node_modules.
CMD ["/app/node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
