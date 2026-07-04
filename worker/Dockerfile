# DWOMOH Vibe Code — Build Worker image
# Runs the SAME Next.js app as the worker (WORKER_ROLE=worker). It needs node + npm
# at RUNTIME because it installs each generated project's dependencies and spawns a
# `next dev` server per generation. Playwright/Chromium is included for verify-app.
FROM node:20-bookworm-slim

# OS deps: build tools for native modules (better-sqlite3), git, and Chromium libs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Playwright browser (chromium only) for the verify-app browser checks
RUN npx playwright install chromium

# App source
COPY . .

# Build the DWOMOH app in production mode
RUN npm run build

# Writable workspace for generated projects (mounted volume in ECS; dir here as fallback)
ENV WORKSPACE_DIR=/workspace
RUN mkdir -p /workspace
VOLUME ["/workspace"]

# Worker identity + ports
ENV WORKER_ROLE=worker \
    NODE_ENV=production \
    NEXT_PORT=3000 \
    EDGE_PORT=8080
EXPOSE 8080

# Edge proxy is PID 1; it spawns `next start` and routes preview/API by Host header.
CMD ["node", "worker/edge-proxy.mjs"]
