# The dashboard is a static site (HTML, JS, CSS): build it with Node, serve it with nginx.
#   docker build -f docker/dashboard.Dockerfile -t dashboard:dev .
# It listens on 8080 and serves ONLY the files. The API (/api) and MCP endpoint (/mcp) are not
# proxied here: the Ingress sends those paths to the gateway, so the browser sees a single origin.

# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /repo
# Copy every workspace manifest first so `npm ci` stays cached until a dependency changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/gateway/package.json apps/gateway/
COPY apps/woo-mcp/package.json apps/woo-mcp/
COPY apps/mcp-fx/package.json apps/mcp-fx/
COPY apps/mcp-notes/package.json apps/mcp-notes/
COPY apps/dashboard/package.json apps/dashboard/
# --ignore-scripts: the dashboard needs none of the install scripts, and skipping them avoids
# compiling the gateway's and notes server's native modules just to build a website.
RUN npm ci --ignore-scripts
COPY apps/dashboard apps/dashboard
RUN npm run build -w apps/dashboard

# ---- runtime stage: nginx that runs as a normal user ----
# "unprivileged" listens on 8080 and runs as UID 101, so the pod can use runAsNonRoot. With a
# read-only root filesystem, mount an emptyDir at /tmp (nginx keeps its pid file and temp files there).
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
