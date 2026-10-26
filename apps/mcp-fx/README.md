# mcp-fx

Currency MCP server: `get_rate`, `convert`, and `server_info`. Streamable HTTP, **stateless**, bearer auth.
Internal only: it is meant to be called by the gateway, never exposed to the internet.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `MCP_AUTH_TOKEN` | yes | 16+ chars; the gateway presents it as `Authorization: Bearer ...` |
| `FX_MODE` | no (`live`) | `live` = Frankfurter API, `static` = built-in offline table (not real data) |
| `FRANKFURTER_BASE_URL` | no | default `https://api.frankfurter.dev/v1` |
| `FX_TIMEOUT_MS` | no (`10000`) | max wait for one Frankfurter call |
| `PORT` / `LOG_LEVEL` | no (`3000` / `info`) | |

## Tools

- `get_rate {from, to, date?}` -> `{from, to, rate, date, source}`
- `convert {amount, from, to, date?}` -> `{amount, from, to, rate, result, date, source}` (result rounded to 4 decimals)
- `server_info {}` -> name, version, where rates come from. **Every server in this platform exposes a tool
  with this exact name** so the gateway's `<slug>__<tool>` namespacing meets a real collision.

Failures (bad currency, API down, timeout) are `isError` results with a readable message, never crashes.
`/healthz` and `/readyz` need no token and never call Frankfurter.

## Run

```sh
MCP_AUTH_TOKEN=0123456789abcdef FX_MODE=static npm run build -w @mcp-platform/mcp-fx
MCP_AUTH_TOKEN=0123456789abcdef FX_MODE=static npm start -w @mcp-platform/mcp-fx
```

## Build, deploy, register in the gateway

```sh
docker build -f docker/node-service.Dockerfile --build-arg APP=mcp-fx -t mcp-fx:dev .
k3d image import mcp-fx:dev -c woo-mcp
helm upgrade --install platform-apps charts/platform -n platform -f charts/platform/values-local.yaml
```

Register it in the gateway as slug `fx`, URL `http://platform-apps-mcp-fx/mcp`, auth `bearer`, credential =
`kubectl -n platform get secret mcp-fx -o jsonpath='{.data.MCP_AUTH_TOKEN}' | base64 -d`.
The gateway must allow the host: `UPSTREAM_ALLOWED_HOSTS=platform-apps-mcp-fx,platform-apps-mcp-notes,...`.
