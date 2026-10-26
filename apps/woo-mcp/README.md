# woo-mcp

An MCP server (Streamable HTTP) that exposes one WooCommerce store as tools. Only the gateway is
meant to call it.

## Tools

| Tool | Does | Hints |
|---|---|---|
| `list_products` | search/filter products | read-only |
| `create_product` | create a simple product (published by default) | additive, not idempotent |
| `list_orders` | orders for `today` / `yesterday` / `last_7_days` in the **store's** time zone | read-only |
| `get_order` | one order with line items | read-only |
| `update_order_status` | set status (enum) | destructive (overwrites status), idempotent |
| `get_sales_summary` | order count, revenue, orders per status for a period | read-only |
| `server_info` | server version, store name/URL/time zone | read-only |

Outputs are trimmed: a few flat fields per item, customer **name only** (no email, phone, address).
Every failure is returned as a normal result with `isError: true` and a message the model can act
on (store unreachable, timeout, bad credentials, order not found, duplicate SKU...).

## How it talks to the store, and why

Through the WooCommerce **REST API** (`/wp-json/wc/v3/...`), logged in as the user `mcp-bot`
(role `shop_manager`) with an Application Password. Why REST and not WP-CLI or the database:
it is WooCommerce's public, versioned contract; WooCommerce enforces its own rules (SKU
uniqueness, stock, status transitions); and it needs nothing shared with the store pod (no
volume, no database credentials, no `kubectl exec`). WP-CLI would need exec rights into the
WordPress pod; direct SQL would bypass WooCommerce's logic.

The call is plain HTTP inside the cluster, so every request carries `X-Forwarded-Proto: https`.
Why that is needed and how it is safe: `charts/store/README.md`, "REST auth over internal HTTP".

**Store time zone.** WooCommerce's settings endpoints do not expose it. The public WordPress REST
index (`GET /wp-json/`) does (`timezone_string`, `gmt_offset`), so that is where it is read, on
every call. Check yours: `curl -s http://shop.localtest.me/wp-json/ | grep -o '"timezone_string":"[^"]*"'`.
Day boundaries are computed in that zone, daylight saving included. Orders are filtered
exactly by their UTC timestamp (`date_created_gmt`), so the result does not depend on how WooCommerce
interprets its `after`/`before` parameters.

## Stateless

Every `POST /mcp` builds a new `McpServer` and transport, answers, and discards them. No session id
is issued, `GET`/`DELETE /mcp` return 405, and any replica can answer any request.

## Configuration (environment)

| Variable | Required | Meaning |
|---|---|---|
| `MCP_AUTH_TOKEN` | yes (16+ chars) | bearer token callers must send |
| `WC_BASE_URL` | yes | e.g. `http://platform-store-wordpress` |
| `WC_USERNAME`, `WC_APP_PASSWORD` | yes | the `mcp-bot` account |
| `PORT` | no (3000) | |
| `LOG_LEVEL` | no (info) | |
| `WC_TIMEOUT_MS` | no (15000) | deadline for one store call |

Endpoints: `POST /mcp` (bearer token), `GET /healthz`, `GET /readyz` (no token).

## Tests

```bash
npm install                      # once, at the repo root; commit package-lock.json
npm test -w apps/woo-mcp
```

A fake WooCommerce API (`src/test/fakeWc.ts`) stands in for the store; the MCP tests use the real
SDK client and server over an in-memory pipe, the HTTP tests start the real Express app.

## Deploy locally and try it with MCP Inspector

```bash
docker build -f docker/node-service.Dockerfile --build-arg APP=woo-mcp -t woo-mcp:dev .
k3d image import woo-mcp:dev -c woo-mcp

# .env needs MCP_AUTH_TOKEN now (openssl rand -hex 32), then:
./scripts/bootstrap-secrets.sh
helm upgrade --install platform charts/store -n platform --create-namespace \
  -f charts/store/values-local.yaml --timeout 15m      # do NOT add --wait, see below
kubectl -n platform get pods                           # woo-mcp becomes Ready once the Job has run

kubectl -n platform port-forward svc/platform-store-woo-mcp 3000:80
TOKEN=$(kubectl -n platform get secret woo-mcp -o jsonpath='{.data.MCP_AUTH_TOKEN}' | base64 -d)
npx @modelcontextprotocol/inspector
```

In Inspector choose transport **Streamable HTTP**, URL `http://localhost:3000/mcp`, add the header
`Authorization: Bearer <TOKEN>`, connect, list tools, run `create_product`, then open
`http://shop.localtest.me` and find the product.

`--wait` would deadlock: Helm would wait for woo-mcp to become Ready before running the Job that
creates the Secret woo-mcp needs.

## Network policy

Only pods labelled `app=gateway` in namespace `platform` may connect to port 3000
(`charts/store/templates/woo-mcp.yaml`). `kubectl port-forward` is not affected by NetworkPolicy,
which is why Inspector works while other pods cannot reach the server:

```bash
# blocked (times out):
kubectl -n platform run np --rm -it --restart=Never --image=curlimages/curl -- \
  curl -m 5 -s -o /dev/null -w '%{http_code}\n' http://platform-store-woo-mcp/healthz
# allowed:
kubectl -n platform run np --rm -it --restart=Never --image=curlimages/curl --labels app=gateway -- \
  curl -m 5 -s -o /dev/null -w '%{http_code}\n' http://platform-store-woo-mcp/healthz
```
