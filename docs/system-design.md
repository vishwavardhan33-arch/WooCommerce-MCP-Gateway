# System design

This document describes what the code does today and why. Where something is missing or untested it says so;
the gaps are collected in [section 9](#9-known-gaps) and, from the security side, in the
[threat model](threat-model.md). File paths are relative to the repository root.

**Reading note on verification:** the code was written without an npm registry, Docker or a cluster. Pure-logic
modules were executed; the database, HTTP, Helm and image paths have not been (see the README's Status).

## 1. Goals and constraints

The system lets a small team share MCP tools through one authenticated endpoint, with an audit trail and a
dashboard. It was built under these rules, which explain many choices below:

- TypeScript (strict), Node 20, npm workspaces, zod for validation, pino logging, vitest, Postgres via drizzle,
  the official `@modelcontextprotocol/sdk`, React + Vite + Tailwind + shadcn/ui.
- 12-factor configuration (environment variables, no secrets in code or git); `/healthz` and `/readyz` on every
  service; graceful shutdown; non-root, read-only-root-filesystem containers; multi-arch images.
- Every error returned to MCP clients is an `isError` result with a clear message.
- Kubernetes with **Helm only**: k3d locally, k3s on a VPS, with differences only in `values-local.yaml` /
  `values-prod.yaml`. Everything must cost $0.
- Code simple enough to explain line by line.

## 2. Components

```
clients ──► /mcp ──┐                         ┌─► woo-mcp ──► WordPress/WooCommerce (REST, Application Password)
dashboard ─► /api ─┼─► gateway ─► UpstreamManager ─┼─► mcp-fx ───► Frankfurter API (or a built-in table)
chat (SSE) ────────┘      │                        └─► mcp-notes ─► SQLite file
                          └─► Postgres (users, sessions, api_keys, invites, mcp_servers, tool_policies, audit_log)
```

**Gateway** (`apps/gateway`, Express 5):

| Area | Files | Job |
|---|---|---|
| Accounts | `src/auth/*`, `src/routes/{auth,invites,users,apiKeys}.ts` | argon2id passwords, server-side cookie sessions, one-time invite links, API keys, admin/member guards |
| MCP endpoint | `src/routes/mcp.ts`, `src/mcp/*` | per-request Bearer authentication, `createGatewayServer(principal)`, permission checks, audit |
| Upstreams | `src/upstream/*`, `src/servers/service.ts`, `src/routes/servers.ts` | registry, health loop, tool cache, namespacing, circuit breaker, SSRF guard, encrypted credentials |
| Audit/read APIs | `src/routes/audit.ts` | filterable list and per-server latency/error summary |
| Chat | `src/chat/*`, `src/routes/chat.ts` | OpenAI-compatible tool-calling loop over the same gateway server object |
| Data | `src/db/schema.ts`, `drizzle/0000_init.sql` | schema and the migration applied at start |

**Dashboard** (`apps/dashboard`): a static single-page app served by nginx. It only calls `/api/*` (cookie) and
`/api/chat`. It is role-aware for presentation; the gateway enforces every permission itself.

**Upstream servers** (`apps/woo-mcp`, `apps/mcp-fx`, `apps/mcp-notes`): each is a small, stateless MCP server over
Streamable HTTP with a static bearer token, `/healthz` and `/readyz`, and a tool named exactly `server_info`
(a deliberate, real name collision for the gateway to resolve). They are written in the same pattern and
deliberately do not share code (three copies of about 100 lines); extracting a shared package is a reasonable refactor.

## 3. Key decisions

| Decision | Why | Trade-off / alternative |
|---|---|---|
| `/mcp` is **stateless** Streamable HTTP | any replica can answer; revocation and permission changes apply to the very next request; nothing to store or expire | no server-to-client messages; see [section 5](#5-the-stateless-session-tradeoff) |
| Low-level SDK `Server` for the gateway | the tool list changes at runtime (servers come and go); `McpServer` wants tools registered up front with schemas | a little more code in `src/mcp/gatewayServer.ts` |
| Tools published as `<slug>__<tool>`, at most 64 chars of `[A-Za-z0-9_-]` | unambiguous routing and no collisions between servers; the limits are what model APIs accept | long names get an 8-hex-char hash suffix; slugs must start with a letter and cannot contain `__` |
| Listing is served **from a cache** filled by a background loop | one slow or dead upstream can never block `tools/list` | a tool list can be up to one health interval (10 s) stale |
| Circuit breaker: 2 consecutive failures | a dead server stops costing every caller a full timeout; its tools disappear instead of failing | two failures is aggressive; a flaky server flaps (no hysteresis) |
| API keys: `mcp_` + 256 random bits, stored as **sha256** | a high-entropy secret needs no slow hash, so checking a key on every request is cheap | a leaked database cannot be brute-forced, but sha256 is not salted (unnecessary at 256 bits) |
| Passwords: **argon2id** (19 MiB, 2 passes, 1 lane) | human passwords are low entropy; the memory cost is what slows GPU guessing | ~tens of ms of CPU per login |
| Dashboard sessions: random token in an HttpOnly, SameSite=Lax cookie; its HMAC-SHA256 (keyed with `SESSION_SECRET`) in Postgres | logout and revocation are immediate; a database leak alone cannot forge a cookie | one DB read per request |
| Upstream credentials encrypted with **AES-256-GCM** (`CREDENTIAL_ENC_KEY`), never returned by any API | the database alone does not reveal them; GCM detects tampering | one key for everything, no key id or rotation (gap) |
| SSRF guard on registration **and** on every connect | admins type URLs the gateway then calls; metadata and link-local addresses are never allowed, private ranges only for allowlisted hosts | not DNS-pinned and does not stop redirects (gaps) |
| Audit stores argument **shapes**, not text | the log must not become a second copy of customer data or secrets | you cannot tell *what* was searched, only that something was |
| Chat speaks the OpenAI chat-completions protocol | many providers (including free tiers and local models) implement it, so cost stays $0 | Gemini accepts only a subset of JSON Schema, so tool schemas go through an allowlist converter |
| `mcp-notes` uses SQLite | zero extra infrastructure | one pod, `Recreate` strategy, not scalable |
| Postgres for the gateway, drizzle migrations at startup | simple to run; one transaction per start | concurrent first starts: the loser crashes and restarts once |

## 4. Aggregation, routing and failure handling

### 4.1 Aggregation: building one tool list

`UpstreamManager` (`src/upstream/manager.ts`) owns one `Upstream` per **enabled** row of `mcp_servers`:

1. Every 10 seconds (and immediately after an admin changes a server) it re-reads the table and reconciles: new
   rows start, disabled or deleted rows are closed (their stored status is reset to `unknown`), and a row whose
   URL, auth type, credential or timeout changed is rebuilt from scratch. A row with an invalid slug is skipped
   with a warning.
2. It then probes **every server concurrently** (`Promise.allSettled`; each probe bounded by that server's
   own timeout): connect if needed, `tools/list` (following pagination, at most 20 pages) and replace that server's cache.
3. Each cached tool is published with `name = namespacedName(slug, tool.name)` and
   `description = "[slug] " + description`; everything else the upstream declared (input schema, annotations) is kept.
4. `tools/list` on the gateway reads only the caches, drops tools disabled in `tool_policies`, and returns. It never
   waits for an upstream.

Naming (`src/upstream/namespacing.ts`): `<slug>__<tool>` when that is already valid and within 64 characters;
otherwise invalid characters become `_`, the name is cut, and `_` + the first 8 hex chars of the sha256 of the
original name are appended, so `a.b` and `a_b`, or two long names with the same start, cannot collide.

### 4.2 Routing: one tool call

```
POST /mcp  (Authorization: Bearer mcp_...)
 1. apiKeyAuth       key -> sha256 -> api_keys JOIN users, not revoked  -> Principal {user, role, key id, source "mcp"}   else 401
 2. createGatewayServer(principal)   a fresh low-level MCP Server for this request
 3. tools/call name  UpstreamManager.locate(name): text before the first "__" is the slug -> server id + upstream tool name
 4. policy check     tool_policies enabled=false for (server, upstream tool name) -> isError "disabled by an administrator", status "denied"
 5. Upstream.call    down? -> fail fast. cache lookup -> original name. withClient(timeout) -> callTool
                     a 404 (session gone) -> drop the client, reconnect, retry ONCE
 6. result           passed through untouched, including the upstream's own isError results
 7. audit            one audit_log row (written before the response; a failed write is logged, never fails the call)
```

The chat agent reuses steps 2 to 7: `routes/chat.ts` connects an MCP client to `createGatewayServer(principal)` over an
in-memory transport with `source: "chat"` and no API key, so permissions, hidden tools and audit are identical.

### 4.3 Failure handling

| Situation | What happens | Counts toward the breaker? |
|---|---|---|
| Upstream slow | the call is cut at the server's `timeout_ms` (1 to 120 s, default 15 s); the client gets an `isError` result that warns the operation may still have run upstream | yes |
| Upstream unreachable or refusing (ECONNREFUSED, DNS, HTTP 5xx, HTTP 401 on connect) | recorded as the server's `last_error` | yes |
| 2 consecutive failures (probes or real calls) | server becomes `down`: tools hidden, calls fail immediately with "unreachable since ...", `status`, `status_since`, `last_error` stored | (the trigger) |
| Down server | still probed every tick; the **first** successful probe marks it `up`, rebuilds the cache and resets `status_since` | n/a |
| Upstream answers a call with a JSON-RPC error (invalid arguments, unknown tool) | returned as an `isError` result; the server is alive | no |
| Upstream tool reports `isError: true` | passed through untouched | no |
| Upstream forgot our session (HTTP 404) | drop client, reconnect, retry once; not a failure | no |
| Unknown server prefix or tool | `isError` listing the known servers | no |
| Slow upstream during listing | irrelevant: listing reads the cache | n/a |
| Audit write fails | logged; the user's call still succeeds | n/a |
| Policy lookup fails (database error) | the call is refused (fails closed); `tools/list` returns a protocol error rather than an unfiltered list | n/a |
| Gateway database down | `/readyz` returns 503; `/mcp` and `/api` answer 500 (JSON-RPC internal error on `/mcp`); health-loop writes are logged and skipped | n/a |
| Model API rate limit (chat) | up to 3 retries after `Retry-After`, or 1, 2, 4 s with jitter; a wait over 20 s is reported instead of held | n/a |
| Browser leaves during chat | the model call and any tool call are aborted | n/a |
| Invalid configuration at start | exits 1 naming the variables (never the values) | n/a |
| Migration or admin bootstrap fails at start | logs and exits 1 so Kubernetes restarts the pod | n/a |
| SIGTERM | `/readyz` goes 503, the HTTP server drains, the manager closes its clients, the pool closes; forced exit after 10 s | n/a |

What is **not** handled: no hysteresis or exponential backoff of probes to a down server (it is probed every
10 s forever), no cap on upstream response size, no cap on the number or size of published tools, and probes
from several gateway replicas are not coordinated (section 7).

## 5. The stateless-session tradeoff

`POST /mcp` creates a new MCP `Server` and transport for every request and issues no `Mcp-Session-Id`
(`routes/mcp.ts`; `GET` and `DELETE` answer 405).

**What this buys**

- Any gateway replica can answer any request: no sticky sessions, no shared session store.
- Authentication happens on **every** request, so a revoked key, a changed role, a disabled server or a newly
  disabled tool takes effect on the next call. There is no "session that outlived its key".
- Nothing to expire, resume, leak or clean up.

**What this costs**

- **No server-to-client traffic.** No `listChanged` notifications (the gateway advertises `tools: {}` only), no
  server-initiated requests (sampling, elicitation), no resumable streams. Clients must call `tools/list` again to
  see changes.
- **Upstream progress and log notifications are dropped.** The gateway forwards only a call's final result.
- **More work per request:** one API-key lookup (plus a `last_used_at` update at most once a minute), a policy
  query, and for `tools/call` an audit insert, plus building a server object.
- There is no per-conversation state in the gateway, so any "memory" has to live in the client (the dashboard
  chat sends its own history each time).

**The upstream side is different:** the gateway holds a long-lived MCP client (and, for stateful upstreams, a
session) per upstream. That is why session-expiry reconnection exists. The three bundled upstreams are
stateless themselves, so this path is exercised only by tests against a stateful mock.

**Alternative:** stateful sessions would allow notifications and progress, but need sticky routing or shared
storage and would make revocation per-session. For a team gateway whose clients re-list tools on connect, the
stateless model was judged the better fit; revisit it if you need long-running tools with progress reporting.

## 6. Data model (Postgres)

| Table | Purpose | Notes |
|---|---|---|
| `users` | accounts | lower-case unique email, argon2id hash, role `admin` or `member` |
| `invites` | one-time sign-up links | sha256 of the token, `used_at`, expiry (default 72 h); claimed atomically |
| `sessions` | dashboard logins | HMAC of the cookie token, expiry (default 24 h); expired rows are not deleted (gap) |
| `api_keys` | MCP credentials | prefix, sha256, `revoked_at`, `last_used_at`; revocation keeps the row |
| `mcp_servers` | upstream registry | slug, URL, auth type, `credential_enc`, `enabled`, `timeout_ms`, `status`, `status_since`, `last_error` |
| `tool_policies` | admin switch per (server, tool) | `enabled=false` hides and rejects; **no API or UI edits it yet** (rows must be inserted by hand) |
| `audit_log` | one row per `tools/call` | user, key (null for chat), `action`, `target`, `ok`, and `detail` JSON: source, server, tool, duration, status `ok`/`error`/`denied`, error cut to 300 chars, argument shapes |

The migration (`drizzle/0000_init.sql`) was written by hand to match `schema.ts` and has no drizzle-kit snapshot;
regenerate it with `drizzle-kit` once (see `apps/gateway/README.md`) before making schema changes.
Authentication failures are logged to stdout only (`mcp auth failed`, with a reason and the key's display prefix),
not stored.

## 7. Scaling and multiple gateway replicas (not tested)

The request path is stateless, so running several replicas is expected to work. The background parts are not
coordinated: **every replica** runs its own `UpstreamManager`, health loop and upstream clients. Consequences:
N replicas send N times the probes; each writes `status`, `status_since` and `last_error` for the same rows
(last write wins), so a flapping server can show conflicting states; and a replica's breaker state is its own, so
replicas can briefly disagree about whether a server is up. A Postgres advisory lock (one replica probes and
writes) or per-replica status columns would fix this. Concurrent first starts race on migrations (the loser
crashes once and restarts). `mcp-notes` is a single pod by design.

## 8. What changes for production

Status: **missing** = not in the repository, **partial**, **ok** = present.

| Area | Needed | Status |
|---|---|---|
| Deployment | Helm charts for gateway, dashboard, and Postgres (or a managed database); Ingress routing `/api` and `/mcp` to the gateway and `/` to the dashboard; pod labels `app: gateway` that the upstream NetworkPolicies expect | **missing** |
| TLS | certificate Secret per host (cert-manager or by hand), HTTP to HTTPS redirect; `COOKIE_SECURE=true` (the default) | **partial** (store values expect `shop-tls`; nothing creates it) |
| Network | default-deny NetworkPolicies with explicit allows for every pod, egress included | **partial** (allow-ingress policies exist for woo-mcp, mcp-fx, mcp-notes only) |
| Images | deploy by commit SHA or digest (values still say `latest` with `OWNER/REPO` placeholders); vulnerability scanning; image pull secrets if private | **partial** |
| Secrets | an external secret manager or sealed secrets; rotation procedures; a key id and re-encryption path for `CREDENTIAL_ENC_KEY` | **partial** (`scripts/bootstrap-secrets.sh`; no rotation) |
| Abuse protection | login rate limiting and lockout, per-key rate limits, request body and result size caps, password change/reset | **missing** |
| Data hygiene | job to delete expired sessions and old invites; audit retention/partitioning; Postgres backups | **missing** |
| High availability | multiple gateway replicas with coordinated health probing; PodDisruptionBudgets; resource limits for the gateway | **missing** |
| Observability | metrics (request rates, upstream latency, breaker state), tracing, alerting on `down` servers; today only pino JSON logs | **missing** |
| Proxy awareness | `app.set("trust proxy")` so logs and any future rate limiter see the real client address | **missing** |
| Security work | tool-definition pinning, redirect refusal, DNS pinning, human confirmation for write tools in chat, per-role tool permissions, a UI/API for `tool_policies` | **missing** (see the threat model) |
| Database | regenerate the migration with drizzle-kit; run migrations as a pre-upgrade Job rather than at pod start | **partial** |
| Pod security | namespace Pod Security labels (`baseline` enforce, `restricted` warn: WordPress runs as root); read-only root filesystem for MariaDB | **missing** |
| Differences | local vs prod value differences limited to domains, storage, images, resources, TLS, secrets source | **partial** (`mcpFx.mode` still differs) |

## 9. Known gaps

Collected from the sections above and from reviewing the code and charts. The security ones are discussed in the
[threat model](threat-model.md).

1. No Helm charts for the gateway, dashboard and Postgres; `make smoke` cannot pass until they exist.
2. No default-deny NetworkPolicies; MariaDB and WordPress have no policy.
3. Upstream URLs are SSRF-checked, but HTTP **redirects are followed** and DNS is not pinned.
4. No tool-definition pinning: an upstream can change a tool's description or schema at any time and clients
   (including the chat model) see it within 10 seconds.
5. `tool_policies` has no API or UI, and policies apply to every user alike (no per-role tool permissions).
6. Any member can call write tools (`shop__update_order_status`, `shop__create_product`), and the chat agent runs
   tools without asking the person first.
7. No rate limiting or lockout on login or on `/mcp`; no password change or reset.
8. No cap on upstream result size or on tool metadata size.
9. Expired sessions are never deleted; the audit log has no retention policy.
10. One encryption key for all upstream credentials, with no rotation support.
11. Multi-replica behavior of the health loop is uncoordinated and untested.
12. The hand-written migration and everything that needs the SDK, Postgres, Docker or a cluster has not been run.
