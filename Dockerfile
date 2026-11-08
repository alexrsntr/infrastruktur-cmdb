# syntax=docker/dockerfile:1.7
# Infrastruktur CMDB – container image (API + web UI in one Node.js process).
# Ready-made image: ghcr.io/alexrsntr/infrastruktur-cmdb – see docker-compose.yml and the README.

# ---- build: compile server bundle and web UI (platform independent output)
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && mkdir -p /data-skel

# ---- runtime dependencies (pure JavaScript, no native modules)
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- runtime
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    AUTH_MODE=local \
    DB_AUTH=password \
    STORAGE_DRIVER=database
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json ./
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/cmdb-entrypoint
# /data keeps the generated secrets (session + settings encryption key) across restarts
COPY --from=build --chown=node:node /data-skel /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/cmdb-entrypoint"]
CMD ["node", "--enable-source-maps", "dist/server.mjs"]
