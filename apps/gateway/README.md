# gateway

Team MCP gateway backend: accounts (login, invites, API keys) and the upstream manager.

## Environment (12-factor, nothing else is read)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:password@host:5432/gateway` |
| `SESSION_SECRET` | yes | 32+ chars. `openssl rand -hex 32` |
| `ADMIN_BOOTSTRAP_EMAIL` | yes | first admin, created only if no admin exists |
| `ADMIN_BOOTSTRAP_PASSWORD` | yes | 12+ chars |
| `PUBLIC_BASE_URL` | yes | dashboard URL; invite links are `<it>/invite/<token>` |
| `CREDENTIAL_ENC_KEY` | yes | 64 hex chars (AES-256 key). `openssl rand -hex 32` |
| `UPSTREAM_ALLOWED_HOSTS` | no (empty) | comma-separated hostnames allowed to resolve to private addresses, e.g. `platform-woo-mcp,*.svc.cluster.local` |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | no (all three enable chat) | any OpenAI-compatible chat-completions API (Groq, OpenRouter, Gemini compat endpoint, Ollama...). Pick one that costs nothing |
| `COOKIE_SECURE` | no (`true`) | set `false` for plain-http local runs |
| `SESSION_TTL_HOURS` / `INVITE_TTL_HOURS` | no (`24` / `72`) | |
| `PORT` / `LOG_LEVEL` | no (`3000` / `info`) | |

## REST API

| Method + path | Who | Purpose |
|---|---|---|
| `POST /api/auth/login` `{email,password}` | public | sets the session cookie |
| `POST /api/auth/logout` | anyone | deletes the session |
| `GET /api/auth/me` | logged in | current user |
| `POST /api/invites` `{email,role?}` | admin | returns the one-time link |
| `POST /api/invites/:token/accept` `{password}` | public | creates the account |
| `GET /api/invites` | admin | invitation status (never the link) |
| `GET /api/users` | admin | team with active key counts |
| `PATCH /api/users/:id` `{role}` | admin | change a role (not your own) |
| `GET /api/users/:id/api-keys` | admin | someone's keys (prefix, dates) |
| `GET /api/servers` | logged in | servers + status; `lastError` only for admins; never a credential |
| `POST` / `PATCH /:id` / `DELETE /:id` `/api/servers` | admin | create / edit (slug is fixed) / delete; URL is SSRF-checked, credential encrypted |
| `GET /api/tools` | logged in | published tools grouped by server |
| `GET /api/audit?server=&tool=&status=&source=&userId=&limit=&offset=` | logged in | admins: all rows; members: only their own |
| `GET /api/audit/summary?hours=24` | logged in | per-server calls, errors, denied, avg and p95 latency |
| `GET /api/chat/status`, `POST /api/chat` | logged in | chat availability; streamed answer (Server-Sent Events) |
| `POST /api/api-keys` `{name}` | logged in | returns the key once |
| `GET /api/api-keys` | logged in | own keys (prefix, dates) |
| `POST /api/api-keys/:id/revoke` | owner or admin | |

## Chat (`POST /api/chat`, Server-Sent Events)

Per turn the gateway builds `createGatewayServer(principal)` for the logged-in user (source `chat`, no API key),
connects an MCP client to it over an in-memory pipe, lists the tools, and runs the model loop (at most 8 rounds).
So permissions, hidden tools and audit rows are exactly those of an external MCP client: every tool call the
assistant makes is attributed to the person chatting.

- **Model API:** any OpenAI-compatible `chat/completions` endpoint, set by `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`
  (all three or chat is off). In Kubernetes they come from the `gateway-app` Secret
  (`envFrom: secretRef: gateway-app`; `scripts/bootstrap-secrets.sh` writes them from `.env`).
- **Tool schemas** are converted with an allowlist (`src/chat/schema.ts`): only `type`, `description`, `enum`,
  `properties`, `required`, `items`, `nullable` are sent, so Gemini's strict endpoint accepts them. Dropped constraints
  (ranges, formats, defaults) are written into the description. A tool with no arguments is sent without `parameters`.
- **429 handling:** up to 3 retries after `Retry-After` (or 1 s / 2 s / 4 s with jitter). A wait longer than 20 s
  is not held open: the chat reports it. The browser gets a `retry` event while waiting.
- **System prompt** (`src/chat/prompt.ts`) contains the current date and time in the person's time zone (the browser
  sends `timezone`; anything that is not a real IANA zone becomes UTC) and states that tool output is untrusted data.
- **Events:** `text` (token deltas), `tool_call` (name, args), `tool_result` (name, duration, result preview cut to
  2,000 characters, `truncated`), `retry`, `error`, `done`.

## MCP endpoint

`POST /mcp` (Streamable HTTP, stateless). Auth: `Authorization: Bearer <API key>`, checked on **every**
request, so a revoked key stops working on the next call. In MCP Inspector choose *Streamable HTTP*,
enter the URL (`<PUBLIC_BASE_URL host>/mcp`) and add the header `Authorization: Bearer mcp_...`.

- `tools/list`: every tool of every healthy server (from cache), minus tools disabled in `tool_policies`.
- `tools/call`: policy check (disabled = rejected, upstream never contacted), forward, audit. Every failure
  is an `isError` result with a readable message.
- `createGatewayServer(principal, deps)` (`src/mcp/gatewayServer.ts`) builds the server for one principal;
  the chat agent connects it to an in-memory transport and gets the same checks and audit.
- Audit: one `audit_log` row per `tools/call`: `actor_user_id`, `api_key_id` (null for chat), `action='tool.call'`,
  `target` (requested name), `ok`, and `detail` = `{source, server, tool, durationMs, status, error, args}`.
  `status` is `ok | error | denied`; `error` is cut to 300 chars; `args` holds argument names, types and sizes only
  (never text; names that look secret are `[redacted]`).
- Auth failures are logged (`mcp auth failed`, with reason and key prefix, never the key).

Probes: `GET /healthz`, `GET /readyz` (checks the database).

## Upstream manager (`src/upstream/`)

- One MCP client per **enabled** row of `mcp_servers`; the table is re-read every health tick, so
  enabling, disabling or editing a row takes effect within 10 s.
- Every 10 s each server is probed with `tools/list`; the result is the tool cache. `listTools()` reads
  only the cache. All probes run concurrently (`Promise.allSettled`), each bounded by that server's `timeout_ms`.
- Tool names are `<slug>__<tool>`, at most 64 chars of `[A-Za-z0-9_-]`; names that need fixing get a short
  hash of the original appended. Descriptions are prefixed `[slug]`. Slugs: lower-case letters, digits, single hyphens.
- Circuit breaker: 2 consecutive failures (probes or calls) -> `down`: tools hidden, calls fail at once.
  The next successful probe brings it back. The state is stored in `mcp_servers.status / status_since / last_error`.
- A 404 on an existing session means the server forgot us: reconnect once and retry, not counted as a failure.
- SSRF guard (`ssrf.ts`): metadata and link-local addresses are always refused; private/internal addresses
  only for hosts in `UPSTREAM_ALLOWED_HOSTS`. Checked on every connect. Call `assertUrlAllowed` when a server is registered too.

## Run locally

```sh
docker run --rm -d --name gw-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16-alpine
npm run build
DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres \
SESSION_SECRET=$(openssl rand -hex 32) \
ADMIN_BOOTSTRAP_EMAIL=admin@example.com ADMIN_BOOTSTRAP_PASSWORD=change-me-please-123 \
PUBLIC_BASE_URL=http://localhost:3000 COOKIE_SECURE=false \
npm start -w @mcp-platform/gateway
```

## Changing the schema

Edit `src/db/schema.ts`, run `npm run db:generate -w @mcp-platform/gateway`, commit the new
file in `drizzle/`. The service applies pending migrations when it starts.
