# dashboard

The web UI of the MCP gateway: React + Vite + TypeScript, Tailwind, shadcn/ui components, TanStack Query.
It is a static site; all data comes from the gateway's REST API (`/api/*`) with the session cookie.

## Run

```sh
# 1. the gateway (see apps/gateway/README.md) on :3000
# 2. the dashboard on :5173; Vite proxies /api and /mcp to the gateway, so it is one origin like in production
npm run dev -w @mcp-platform/dashboard            # GATEWAY_URL=http://host:port to point elsewhere
npm test -w @mcp-platform/dashboard               # pure logic: formatting, connect snippets, stream parser
npm run build -w @mcp-platform/dashboard          # type-check + production build into dist/
```

Image: `docker build -f docker/dashboard.Dockerfile -t dashboard:dev .` (nginx on port 8080, runs as non-root;
mount an `emptyDir` at `/tmp` if the root filesystem is read-only; probe `/healthz`).
The Ingress must send `/api` and `/mcp` to the gateway and everything else to this image.

## Pages and who sees them

| Page | Admin | Member |
|---|---|---|
| **Servers** `/servers` | cards with live status (polled every 5 s), tools drawer, add / edit / enable-disable / delete | same cards and tools drawer, read-only; no error details |
| **My key** `/connect` | create / revoke own keys, copy-paste setup for Claude Code, Cursor, MCP Inspector | same |
| **Audit** `/audit` | everyone's calls, filters (server, status, source, tool, user), per-server health (calls, errors, avg, p95) | only their own calls |
| **Chat** `/chat` | streaming assistant using the same tools (needs `LLM_*` on the gateway) | same |
| **Team** `/team` | invite (role), change roles, see each person's keys and revoke, invitation status | hidden (route redirects) |

## User stories and where to do them

- Admin: add a server with a bearer token (Servers > Add server) · see why one is down (hover *Unreachable*) ·
  disable it (switch) · edit its URL / token / timeout · delete it (confirm) · see all available tools (Tools) ·
  invite someone as member or admin (Team > Invite) · change a role · see a person's keys and revoke one ·
  review what happened (Audit) · create my own key and connect a client (My key) · chat (Chat).
- Member: accept an invitation (`/invite/<token>`) · log in · see servers, their status and tools ·
  create a key (shown once) and copy the snippet for my client · revoke my key · see my own activity ·
  chat.

## Design notes

- **Credentials are never rendered.** The API returns only `hasCredential`. The token field is write-only
  (`type=password`, empty on edit; empty means "keep the saved one"). A new API key or invite link exists only
  in component state / a mutation result with `gcTime: 0`, and disappears when dismissed.
- **Role-aware, not role-secured.** The Team link and page are hidden from members for a clean UI; the gateway
  enforces every permission itself (403 on admin endpoints, members only ever get their own audit rows).
- **Polling:** servers every 5 s while the page is open (the manager refreshes health every 10 s); audit every 10 s
  when auto-refresh is on. A 401 from any request sends the person back to the login page.
- **Theme:** light and dark follow the system by default; the toggle stores the choice in `localStorage`.
  `public/theme-init.js` applies it before first paint (a separate file because the CSP forbids inline scripts).
- **shadcn/ui:** the components in `src/components/ui` follow shadcn's source and conventions (Radix primitives,
  `cva` variants, CSS-variable colors). They were written by hand; to add more, run `npx shadcn@latest add <name>`
  (`components.json` is configured). Selects are styled native `<select>` elements on purpose.
