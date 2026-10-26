# One Dockerfile for the Node services (gateway, woo-mcp, mcp-fx, mcp-notes). Choose the service with:
#   docker build -f docker/node-service.Dockerfile --build-arg APP=mcp-fx .
# (The dashboard is static files and has its own Dockerfile: docker/dashboard.Dockerfile.)

# ---- build stage: install everything, compile TypeScript, then drop dev dependencies ----
FROM node:20-alpine AS build
ARG APP
WORKDIR /repo
# mcp-notes uses better-sqlite3 (a native module). npm normally downloads a prebuilt binary for
# Alpine (musl) on amd64 and arm64; these tools are the fallback that compiles it if no prebuilt
# one exists. They live only in this build stage: the runtime image below does not get them.
RUN apk add --no-cache python3 make g++
# Copy manifests first so `npm ci` stays cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/gateway/package.json apps/gateway/
COPY apps/woo-mcp/package.json apps/woo-mcp/
COPY apps/mcp-fx/package.json apps/mcp-fx/
COPY apps/mcp-notes/package.json apps/mcp-notes/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
# Build only what this image needs (the shared package and the chosen app), not every workspace:
# a type error in the dashboard must not stop the gateway image from building.
RUN npm run build -w @mcp-platform/shared && npm run build -w apps/${APP} && npm prune --omit=dev

# ---- runtime stage: only what is needed to run one service ----
FROM node:20-alpine
ARG APP
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/package.json ./
# node_modules holds a symlink to packages/shared (npm workspaces), so shared must be copied too.
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/shared packages/shared
COPY --from=build /repo/apps/${APP} apps/${APP}
# Numeric UID: Kubernetes `runAsNonRoot` cannot verify a user given by name.
USER 1000
WORKDIR /repo/apps/${APP}
CMD ["node", "dist/index.js"]
