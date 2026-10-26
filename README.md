# MCP platform: a WooCommerce store, three MCP servers, and a team gateway

One MCP endpoint for a whole team. People sign in to a dashboard, get a personal API key, and connect
Claude Code, Cursor or any MCP client to **one URL**. Behind it the gateway aggregates several MCP
servers, keeps who-did-what in an audit log, and shows the health of each server.

```
 Claude Code / Cursor / Inspector ──Bearer API key──►┐
                                                      │  POST /mcp (stateless Streamable HTTP)
 Browser ── dashboard (React) ── /api (cookie) ──────►│
                          └─ /api/chat (SSE) ─────────┤
                                                      ▼
                                              ┌──────────────┐        ┌────────────┐
                                              │   gateway    │───────►│  Postgres  │ users, keys, servers,
                                              │ (Express/TS) │        └────────────┘ audit log, policies
                                              └──────┬───────┘
                                  one MCP client per upstream, bearer auth, health-checked every 10 s
                       ┌─────────────────────┼──────────────────────┐
                       ▼                     ▼                      ▼
                 woo-mcp (shop__*)      mcp-fx (fx__*)       mcp-notes (notes__*)
                       │                                            │
                 WooCommerce (WordPress + MariaDB)               SQLite file
```

| Folder | What it is |
|---|---|
| `apps/gateway` | the gateway: REST API, `/mcp` endpoint, upstream manager, audit, chat |
| `apps/dashboard` | the web UI (React, Vite, Tailwind, shadcn/ui, TanStack Query) |
| `apps/woo-mcp` | MCP server for the WooCommerce store (orders, products, sales summary) |
| `apps/mcp-fx` | MCP server for currency conversion (Frankfurter, or an offline table) |
| `apps/mcp-notes` | MCP server for notes (SQLite) |
| `charts/store` | Helm chart: WordPress + MariaDB + WooCommerce + woo-mcp |
| `charts/platform` | Helm chart: mcp-fx and mcp-notes |
| `scripts/` | `bootstrap-secrets.sh`, `smoke-test.ts` |
| `docs/` | [system design](docs/system-design.md), [threat model](docs/threat-model.md) |

## Status: read this first

Be honest with yourself about what exists:

- **Nothing here has been run end to end.** The code was written without an npm registry, Docker or a
  cluster. Only pure-logic tests (parsers, schema conversion, namespacing, SSRF rules, retry maths,
  formatting) have actually been executed. The builds, the database and HTTP tests, the Helm charts and
  the images are **unverified until you run them**; expect to fix small things. Start with
  [First ten minutes after cloning](#first-ten-minutes-after-cloning).
- **There is no Helm chart for the gateway, the dashboard or the gateway's Postgres, and no Ingress for
  them.** So today the gateway and dashboard run as plain Node processes (see the quickstart), and the
  in-cluster `make smoke` end-to-end test cannot pass until those charts exist.
- The MCP servers inside the cluster accept connections only from pods labelled `app: gateway` in the
  `platform` namespace (NetworkPolicy), which no chart creates yet. From your laptop you therefore run
  the servers you want to use as local processes (below).
- Hardening gaps are listed in [docs/threat-model.md](docs/threat-model.md) and
  [docs/system-design.md](docs/system-design.md#9-known-gaps). Please read the threat model before you
  put this on the internet.

## First ten minutes after cloning

```bash
npm install                 # commit the generated package-lock.json (the Dockerfiles use `npm ci`)
npm run lint && npm run build && npm test
helm lint charts/store    -f charts/store/values-local.yaml
helm lint charts/platform -f charts/platform/values-local.yaml
```

Test files use an in-memory Postgres (PGlite) and in-process MCP servers: no Docker needed for `npm test`.

## 5-minute quickstart (no Kubernetes)

You get the dashboard, the gateway, and two upstream servers (`fx`, `notes`) whose identical `server_info`
tools show the namespacing at work. You need Node 20+, `openssl`, and Docker (only for Postgres).

```bash
npm install
npm run build -w @mcp-platform/gateway -w @mcp-platform/mcp-fx -w @mcp-platform/mcp-notes

# 1. Postgres
docker run --rm -d --name gw-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16-alpine

# 2. two MCP servers (same bearer token for both, for the demo)
export UPSTREAM_TOKEN=$(openssl rand -hex 16)
MCP_AUTH_TOKEN=$UPSTREAM_TOKEN FX_MODE=static PORT=3101 npm start -w @mcp-platform/mcp-fx &
MCP_AUTH_TOKEN=$UPSTREAM_TOKEN NOTES_DB_PATH=./notes.db PORT=3102 npm start -w @mcp-platform/mcp-notes &   # creates apps/mcp-notes/notes.db

# 3. the gateway on :3000 (the admin account is created from these variables on first start)
DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres \
SESSION_SECRET=$(openssl rand -hex 32) CREDENTIAL_ENC_KEY=$(openssl rand -hex 32) \
ADMIN_BOOTSTRAP_EMAIL=admin@example.com ADMIN_BOOTSTRAP_PASSWORD='change-me-please-123' \
PUBLIC_BASE_URL=http://localhost:5173 COOKIE_SECURE=false UPSTREAM_ALLOWED_HOSTS=127.0.0.1 \
npm start -w @mcp-platform/gateway &

# 4. the dashboard on :5173 (Vite proxies /api and /mcp to the gateway, so everything is one origin)
npm run dev -w @mcp-platform/dashboard
```

Then in the browser at <http://localhost:5173>:

1. Log in as `admin@example.com` / `change-me-please-123`.
2. **Servers > Add server**: slug `fx`, URL `http://127.0.0.1:3101/mcp`, authentication *Bearer token*, token
   `$UPSTREAM_TOKEN` (`echo $UPSTREAM_TOKEN`). Repeat for slug `notes`, URL `http://127.0.0.1:3102/mcp`.
   Both go *Connected* within about 10 seconds.
3. Click **Tools**: you see `fx__convert`, `notes__create_note`, … and both `fx__server_info` and
   `notes__server_info`: the same tool name from two servers, kept apart by the prefix.
4. **My key**: generate a key and copy it (it is shown once).
5. Try it without any client:
   ```bash
   curl -s http://localhost:5173/mcp -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```
6. Open **Audit** after making a call: your calls are listed with the key, server, tool and duration.

Stop everything with `kill $(jobs -p); docker stop gw-pg`. Delete `apps/mcp-notes/notes.db*` to forget the notes.

## Local setup with Kubernetes (k3d)

This brings up the WooCommerce store and the two demo servers **inside** a local cluster. Needs Docker,
`k3d`, `kubectl`, `helm`.

```bash
make up                                  # empty k3d cluster "woo-mcp"; Traefik on http://127.0.0.1:80
cp .env.example .env                     # then fill every value (openssl rand -hex 16 / 32); LLM_* may stay empty
./scripts/bootstrap-secrets.sh           # creates the Secrets in namespace "platform" (no secret ever goes in git)

# images built locally and loaded into k3d (no registry needed)
for app in woo-mcp mcp-fx mcp-notes; do
  docker build -f docker/node-service.Dockerfile --build-arg APP=$app -t $app:dev .
done
k3d image import woo-mcp:dev mcp-fx:dev mcp-notes:dev -c woo-mcp

# the store (release name "platform" is what `make logs` and `make demo-reset` expect)
helm upgrade --install platform charts/store -n platform --create-namespace \
  -f charts/store/values-local.yaml --timeout 15m
helm test platform -n platform           # checks the REST API and the bot account from inside the cluster

# the demo MCP servers: their OWN release name (the store already owns "platform")
helm upgrade --install platform-apps charts/platform -n platform -f charts/platform/values-local.yaml
kubectl --context k3d-woo-mcp -n platform get pods
```

- Store: <http://shop.localtest.me> (`*.localtest.me` resolves to 127.0.0.1). WordPress admin:
  <http://shop.localtest.me/wp-admin>, user `wpadmin`, password `WP_ADMIN_PASSWORD` from `.env`.
- `make smoke-cluster` checks that Traefik answers. `make demo-reset` wipes the **store** release and all PVCs
  (it does not uninstall `platform-apps`). `make down` deletes the cluster.
- The first install takes a few minutes: WordPress and WooCommerce are installed by a hook Job
  ([details](charts/store/README.md)).
- **Limit:** with no gateway chart, nothing inside the cluster is allowed to call `platform-apps-mcp-fx` /
  `-mcp-notes` (their NetworkPolicy admits only gateway pods). For the full flow on a laptop, run the gateway
  and the servers you need as local processes as in the quickstart; for the store see the next section.
- `make smoke` (`scripts/smoke-test.ts`) is the end-to-end test of the **complete** platform; it needs the
  gateway reachable at `http://app.localtest.me` and `shop`, `fx`, `notes` registered. It cannot pass until the
  gateway and dashboard are deployed in the cluster.

## Place an order and see it through the gateway

The store sells four seeded products with **Cash on delivery**. MCP tools read and change orders; **placing an
order is done in the storefront** (there is no create-order tool).

1. Start the store ([above](#local-setup-with-kubernetes-k3d)) and keep the quickstart's gateway and dashboard running.
2. Run the WooCommerce MCP server locally, talking to the store through a port-forward (the bot password is
   only accepted over the cluster-internal path, never through the public http Ingress):
   ```bash
   kubectl --context k3d-woo-mcp -n platform port-forward svc/platform-store-wordpress 8081:80 &
   npm run build -w @mcp-platform/woo-mcp
   WC_BASE_URL=http://127.0.0.1:8081 WC_USERNAME=mcp-bot PORT=3103 MCP_AUTH_TOKEN=$UPSTREAM_TOKEN \
   WC_APP_PASSWORD=$(kubectl --context k3d-woo-mcp -n platform get secret platform-store-mcp-bot -o jsonpath='{.data.password}' | base64 -d) \
   npm start -w @mcp-platform/woo-mcp &
   ```
3. In the dashboard: **Servers > Add server**, slug `shop`, URL `http://127.0.0.1:3103/mcp`, Bearer token
   `$UPSTREAM_TOKEN`.
4. Open <http://shop.localtest.me>, add a product to the cart, check out with **Cash on delivery**.
5. Ask for it through the gateway: in **Chat** "What orders came in today?" (needs the LLM settings below), or from
   any client call `shop__list_orders` (`period: today`). `shop__get_order` shows one order;
   `shop__get_sales_summary` totals a period.
6. `shop__update_order_status` changes an order's status (for example to `completed`). **It writes to the store**
   and any signed-in member can call it; see the [threat model](docs/threat-model.md#7-member-versus-member).

## Connect an external client

Sign in, open **My key**, generate a key (shown once, with a name that says where you use it) and copy the
snippet for your client. The URL is your gateway's address plus `/mcp`.

```bash
# Claude Code
claude mcp add --transport http team-gateway http://localhost:5173/mcp --header "Authorization: Bearer mcp_..."
```
```jsonc
// Cursor: ~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project)
{ "mcpServers": { "team-gateway": { "url": "http://localhost:5173/mcp", "headers": { "Authorization": "Bearer mcp_..." } } } }
```
**MCP Inspector:** `npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*, the URL above, header
`Authorization` = `Bearer mcp_...`.

Every tool appears as `<server>__<tool>` (for example `fx__convert`). Revoke a key in **My key**: it stops
working on its very next request. The endpoint is stateless (no session id, no server-to-client notifications), so
a client re-lists tools to see changes ([why](docs/system-design.md#5-the-stateless-session-tradeoff)).

## Use the chat

**Chat** talks to any OpenAI-compatible chat-completions API using the tools you can use, and shows every tool call
as a collapsible chip (arguments, result preview, duration). Choose a provider whose free tier or local option
fits your budget, and set all three on the gateway (in Kubernetes they come from the `gateway-app` Secret):

```bash
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai   # for example; any OpenAI-compatible URL
LLM_MODEL=<the provider's model name>
LLM_API_KEY=<your key>
```

Without all three, the page says chat is not set up. Each tool call the assistant makes is audited under **your**
user with source `chat`. The assistant runs the tools it chooses **without asking you first**; keep that in mind
for write tools.

## VPS setup (k3s)

What the repository supports today is the **store and demo-server charts**; the gateway and dashboard still need
charts (see Status). On a VPS:

1. Install k3s (it ships Traefik and a NetworkPolicy controller): `curl -sfL https://get.k3s.io | sh -`, and
   make its kubeconfig available as a context on your machine.
2. Point DNS A records at the VPS: `shop.<your-domain>` (and `app.<your-domain>` once the gateway chart exists).
3. Edit `charts/store/values-prod.yaml`: `ingress.host`. For TLS provide a certificate Secret named
   `shop-tls` in the namespace, by hand or with cert-manager. **cert-manager is not part of this repo.**
4. Create the Secrets: fill `.env` and run `KUBE_CONTEXT=<your-k3s-context> ./scripts/bootstrap-secrets.sh`.
5. Images: CI (`.github/workflows/ci.yml`) builds multi-arch (amd64 + arm64) images for every app and pushes them to
   `ghcr.io/<owner>/<repo>/<app>` on pushes to `main`, tagged `latest` and the commit SHA. Replace `OWNER/REPO` in the
   values files and deploy **by SHA**, not `latest`:
   ```bash
   helm upgrade --install platform charts/store -n platform --create-namespace -f charts/store/values-prod.yaml \
     --set mcp.image.tag=<commit-sha> --kube-context <your-k3s-context>
   helm upgrade --install platform-apps charts/platform -n platform -f charts/platform/values-prod.yaml \
     --set mcpFx.image.tag=<commit-sha> --set mcpNotes.image.tag=<commit-sha> --kube-context <your-k3s-context>
   ```
   If the GHCR packages are private, create an image pull secret; the charts do not set one.
6. Production differences are limited to domains, storage, images and TLS; notes use a PVC in prod
   (`mcpNotes.persistence.enabled: true`). Everything else the production deployment still needs is listed in
   [docs/system-design.md](docs/system-design.md#8-what-changes-for-production).

## Commands

| | |
|---|---|
| `npm run lint` / `build` / `test` | all workspaces (CI runs these, then `helm lint` for both charts and both values files) |
| `make up` / `down` | create / delete the local k3d cluster |
| `make smoke-cluster` | is the cluster alive and Traefik answering |
| `make smoke` | cluster check, then the end-to-end test of the full platform |
| `make demo-reset` | back to a fresh store (uninstall release `platform`, delete PVCs) |
| `make logs` | follow the logs of release `platform` |

Per-app details: [gateway](apps/gateway/README.md), [dashboard](apps/dashboard/README.md),
[woo-mcp](apps/woo-mcp/README.md), [mcp-fx](apps/mcp-fx/README.md), [mcp-notes](apps/mcp-notes/README.md),
[store chart](charts/store/README.md).
