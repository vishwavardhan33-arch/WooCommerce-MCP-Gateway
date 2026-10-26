# mcp-notes

Notes MCP server: `create_note`, `list_notes`, `get_note`, `search_notes`, and `server_info`, backed by SQLite.
Streamable HTTP, **stateless**, bearer auth. Internal only: it is meant to be called by the gateway.

The MCP layer is stateless (no sessions); the notes themselves persist in one SQLite file.
Notes are shared by everyone who can reach the server: it has no notion of users.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `MCP_AUTH_TOKEN` | yes | 16+ chars; the gateway presents it as `Authorization: Bearer ...` |
| `NOTES_DB_PATH` | no (`/data/notes.db`) | the directory must be writable (WAL side files); use `./notes.db` locally |
| `PORT` / `LOG_LEVEL` | no (`3000` / `info`) | |

## Tools

- `create_note {title, body}` -> `{created: {id, title, preview, created_at}}`
- `list_notes {limit?, offset?}` -> newest first, with a 100-character preview
- `get_note {id}` -> the full note
- `search_notes {query, limit?}` -> case-insensitive substring match on title and body (ASCII case folding only)
- `server_info {}` -> name, version, note count (a collision partner for the other servers' `server_info`)

## Storage in Kubernetes

SQLite is one file, so this is deliberately a **single pod** with `strategy: Recreate`.
`mcpNotes.persistence.enabled=false` (local) uses an `emptyDir`; `true` (prod) uses a PersistentVolumeClaim
that survives pod replacement and `helm uninstall`. The container's own filesystem is read-only; only `/data` is writable.

## Run

```sh
MCP_AUTH_TOKEN=0123456789abcdef NOTES_DB_PATH=./notes.db npm start -w @mcp-platform/mcp-notes
```

## Build, deploy, register in the gateway

```sh
docker build -f docker/node-service.Dockerfile --build-arg APP=mcp-notes -t mcp-notes:dev .
k3d image import mcp-notes:dev -c woo-mcp
helm upgrade --install platform-apps charts/platform -n platform -f charts/platform/values-local.yaml
```

Register it in the gateway as slug `notes`, URL `http://platform-apps-mcp-notes/mcp`, auth `bearer`, credential =
`kubectl -n platform get secret mcp-notes -o jsonpath='{.data.MCP_AUTH_TOKEN}' | base64 -d`.
