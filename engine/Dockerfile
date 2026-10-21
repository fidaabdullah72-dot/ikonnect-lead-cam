# BatSols engine — WhatsApp sessions, campaigns, lead finder, automations.
# The Playwright image ships Chromium + system deps for the browser scraper.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Install only the engine + shared workspaces (better layer caching).
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY engine/package.json engine/
# --include=dev: the bundler (esbuild) is a dev dependency.
RUN npm ci --workspace=@batsols/engine --workspace=@batsols/shared --include-workspace-root=false --include=dev --no-audit --no-fund

COPY packages/shared packages/shared
COPY engine engine
RUN npm run build -w @batsols/engine

ENV NODE_ENV=production
USER pwuser
CMD ["node", "engine/dist/index.js"]
