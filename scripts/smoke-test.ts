// End-to-end smoke test of the DEPLOYED platform (run it with `make smoke` after `make up` and the
// helm installs). It talks to the gateway exactly like a person and an MCP client would, plus
// `kubectl` for the one thing a user cannot do: stopping an upstream.
//
// Story it checks, in order:
//   1. admin logs in; the three upstreams (shop, fx, notes) are registered and Connected
//   2. admin invites members A and B; each accepts, logs in and creates an API key
//   3. an MCP client with ONLY B's URL + key lists tools (including the three server_info
//      collisions), calls list_orders, and runs a two-server flow (fx convert -> notes create/get)
//   4. B's key is revoked: the very next request is rejected, A's key still works
//   5. a server is disabled: its tools vanish; enabling it brings them back
//   6. an upstream is scaled to 0: it turns Unreachable, the others keep working, and it recovers
//   7. the audit log has the rows, attributed to the right person, key and source
//
// Configuration (environment; `make smoke` sets the defaults and loads .env):
//   SMOKE_BASE_URL           gateway origin                      default http://app.localtest.me
//   ADMIN_BOOTSTRAP_PASSWORD admin password (required)           from .env
//   SMOKE_ADMIN_EMAIL        admin email                         default ADMIN_BOOTSTRAP_EMAIL or admin@example.com
//   SMOKE_SHOP / _FX / _NOTES  slugs the servers are registered under   default shop / fx / notes
//   SMOKE_NAMESPACE, SMOKE_KUBE_CONTEXT   where kubectl looks    default platform / (current context)
//   SMOKE_FX_DEPLOYMENT      the upstream that gets scaled       default platform-apps-mcp-fx
//
// It leaves two extra "smoke-*" member accounts behind per run (the API has no user deletion);
// `make demo-reset` wipes them with everything else. Keys, the disabled server and the scaled
// deployment are always put back, even when a check fails.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// ---------------------------------------------------------------- configuration

const env = (name: string, fallback?: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
};

const BASE = (env("SMOKE_BASE_URL", "http://app.localtest.me") as string).replace(/\/+$/, "");
const ADMIN_EMAIL = env("SMOKE_ADMIN_EMAIL", env("ADMIN_BOOTSTRAP_EMAIL", "admin@example.com")) as string;
const ADMIN_PASSWORD = env("ADMIN_BOOTSTRAP_PASSWORD");
const SHOP = env("SMOKE_SHOP", "shop") as string;
const FX = env("SMOKE_FX", "fx") as string;
const NOTES = env("SMOKE_NOTES", "notes") as string;
const NAMESPACE = env("SMOKE_NAMESPACE", "platform") as string;
const KUBE_CONTEXT = env("SMOKE_KUBE_CONTEXT");
const FX_DEPLOYMENT = env("SMOKE_FX_DEPLOYMENT", "platform-apps-mcp-fx") as string;

// One id per run: makes emails, key names and note titles unique, so reruns never collide and the
// audit assertions only look at THIS run's rows.
const RUN = Date.now().toString(36);
const STARTED_AT = Date.now();
const PASSWORD = `Smoke-${RUN}-${randomBytes(9).toString("base64url")}`; // 12+ characters, never printed

// ---- harness: a tiny check runner with a green/red summary ----------------------------------

const useColor = (process.stdout.isTTY && !process.env.NO_COLOR) || Boolean(process.env.FORCE_COLOR);
const paint = (code: number, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (t: string) => paint(32, t);
const red = (t: string) => paint(31, t);
const dim = (t: string) => paint(2, t);
const bold = (t: string) => paint(1, t);

interface Outcome {
  name: string;
  ok: boolean;
  reason: string;
}
const outcomes: Outcome[] = [];

// Stops the whole run: used when nothing after this point can mean anything (no gateway, no login).
class Fatal extends Error {}

const section = (title: string) => console.log(`\n${bold(title)}`);

// Runs one check. A failing check is printed in red and the run CONTINUES, so one run shows every
// problem; `fatal` checks stop the run because the later checks depend on them.
async function check(name: string, fn: () => Promise<void> | void, options: { fatal?: boolean } = {}): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    outcomes.push({ name, ok: true, reason: "" });
    console.log(`  ${green("✓")} ${name} ${dim(`(${Date.now() - started} ms)`)}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    outcomes.push({ name, ok: false, reason });
    console.log(`  ${red("✗")} ${name}\n      ${red(reason)}`);
    if (options.fatal) throw new Fatal(name);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Polls until `probe` returns true. Used for everything that happens in the background (the
// gateway's health loop runs every 10 s, pods take a while to stop and start).
async function waitUntil(what: string, probe: () => Promise<boolean>, timeoutMs: number, intervalMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  for (;;) {
    try {
      if (await probe()) return;
      lastError = "";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for: ${what}${lastError ? ` (last error: ${lastError})` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function printSummary(): boolean {
  const failed = outcomes.filter((o) => !o.ok);
  const seconds = ((Date.now() - STARTED_AT) / 1000).toFixed(1);
  console.log("");
  if (failed.length === 0) {
    console.log(green(bold(`PASSED  ${outcomes.length} of ${outcomes.length} checks`)) + dim(`  (${seconds} s)`));
    return true;
  }
  console.log(red(bold(`FAILED  ${failed.length} of ${outcomes.length} checks`)) + dim(`  (${seconds} s)`));
  for (const o of failed) console.log(`  ${red("✗")} ${o.name}\n      ${o.reason}`);
  return false;
}
// ---- end harness ------------------------------------------------------------------------------

// ---------------------------------------------------------------- talking to the gateway

interface Reply {
  status: number;
  body: unknown;
  headers: Headers;
}

async function call(method: string, path: string, options: { cookie?: string; body?: unknown } = {}): Promise<Reply> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...(options.cookie ? { Cookie: options.cookie } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

// Like `call`, but anything other than the expected status is an error carrying the gateway's own message.
async function must<T = Record<string, unknown>>(method: string, path: string, options: { cookie?: string; body?: unknown; status?: number } = {}): Promise<T> {
  const reply = await call(method, path, options);
  const expected = options.status ?? 200;
  if (reply.status !== expected) {
    const message = (reply.body as { error?: string } | null)?.error ?? JSON.stringify(reply.body);
    throw new Error(`${method} ${path} answered HTTP ${reply.status} (expected ${expected}): ${message}`);
  }
  return reply.body as T;
}

async function login(email: string, password: string): Promise<string> {
  const reply = await call("POST", "/api/auth/login", { body: { email, password } });
  assert(reply.status === 200, `login as ${email} answered HTTP ${reply.status}`);
  const cookie = (reply.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  assert(cookie.startsWith("session="), "login did not set a session cookie");
  return cookie;
}

// ---------------------------------------------------------------- talking MCP

// The same SDK client Claude Code and MCP Inspector are built on, given nothing but a URL and a key.
async function connectMcp(key: string): Promise<Client> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

const toolNames = async (client: Client): Promise<string[]> => (await client.listTools()).tools.map((t) => t.name);

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as { type: string; text?: string }[])[0]?.text ?? "") as string;
  let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!result.isError) {
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON: the checks below will say so */
    }
  }
  return { isError: result.isError === true, text, json };
}

// ---------------------------------------------------------------- kubectl

function kubectl(...args: string[]): string {
  const context = KUBE_CONTEXT ? ["--context", KUBE_CONTEXT] : [];
  try {
    return execFileSync("kubectl", [...context, "-n", NAMESPACE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new Error(`kubectl ${args.join(" ")} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`);
  }
}

// ---------------------------------------------------------------- the story

interface Member {
  label: string;
  email: string;
  id: string;
  cookie: string;
  key: string;
  keyId: string;
  keyName: string;
}

interface ServerRow {
  id: string;
  slug: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
}

const listServers = async (cookie: string) => (await must<{ servers: ServerRow[] }>("GET", "/api/servers", { cookie })).servers;
const serverBySlug = async (cookie: string, slug: string) => (await listServers(cookie)).find((s) => s.slug === slug);

// Things the cleanup block has to undo if the run stops half-way.
let notesDisabled = false;
let fxScaledDown = false;

async function main(): Promise<void> {
  if (!ADMIN_PASSWORD) throw new Error("ADMIN_BOOTSTRAP_PASSWORD is not set (put it in .env; `make smoke` loads it)");
  console.log(bold("MCP platform smoke test") + dim(`  ${BASE}  run ${RUN}`));

  let admin = "";
  const ids: Record<string, string> = {};
  const members: Record<"A" | "B", Member> = {} as Record<"A" | "B", Member>;
  let noteResult = 0;
  let noteId = 0;
  let aClient: Client | undefined;
  let bClient: Client | undefined;

  try {
    // -------------------------------------------------- 1. the platform is up
    section("1. Platform and admin");
    await check("gateway is ready", async () => {
      const reply = await call("GET", "/readyz");
      assert(reply.status === 200, `GET /readyz answered HTTP ${reply.status}: is the gateway deployed and reachable at ${BASE}?`);
    }, { fatal: true });

    await check("admin logs in", async () => {
      admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
      const me = await must<{ user: { role: string } }>("GET", "/api/auth/me", { cookie: admin });
      assert(me.user.role === "admin", `expected role admin, got ${me.user.role}`);
    }, { fatal: true });

    await check(`servers "${SHOP}", "${FX}" and "${NOTES}" are registered, enabled and Connected`, async () => {
      await waitUntil("all three servers to be Connected", async () => {
        const servers = await listServers(admin);
        for (const slug of [SHOP, FX, NOTES]) {
          const s = servers.find((x) => x.slug === slug);
          assert(s, `no server registered with slug "${slug}": add it in the dashboard (or set SMOKE_SHOP / SMOKE_FX / SMOKE_NOTES)`);
          assert(s.enabled, `server "${slug}" is disabled`);
          ids[slug] = s.id;
          if (s.status !== "up") return false;
        }
        return true;
      }, 90_000);
    }, { fatal: true });

    // -------------------------------------------------- 2. users and keys
    section("2. Users A and B");
    const invite = async (label: "A" | "B") => {
      const email = `smoke-${label.toLowerCase()}-${RUN}@example.com`;
      const created = await must<{ url: string }>("POST", "/api/invites", { cookie: admin, body: { email, role: "member" }, status: 201 });
      assert(created.url.includes("/invite/"), "the invitation has no link");
      const token = created.url.split("/invite/")[1] ?? "";
      await must("POST", `/api/invites/${token}/accept`, { body: { password: PASSWORD }, status: 201 });
      const cookie = await login(email, PASSWORD);
      const keyName = `smoke-${label.toLowerCase()}-${RUN}`;
      const made = await must<{ apiKey: { id: string }; key: string }>("POST", "/api/api-keys", { cookie, body: { name: keyName }, status: 201 });
      assert(made.key.startsWith("mcp_"), "the new key does not look like an API key");
      const me = await must<{ user: { id: string; role: string } }>("GET", "/api/auth/me", { cookie });
      assert(me.user.role === "member", `${email} should be a member, got ${me.user.role}`);
      members[label] = { label, email, id: me.user.id, cookie, key: made.key, keyId: made.apiKey.id, keyName };
    };
    await check("admin invites A; A accepts, logs in and creates a key", () => invite("A"), { fatal: true });
    await check("admin invites B; B accepts, logs in and creates a key", () => invite("B"), { fatal: true });
    await check("a member cannot use admin endpoints (403)", async () => {
      const reply = await call("GET", "/api/users", { cookie: members.A.cookie });
      assert(reply.status === 403, `GET /api/users as a member answered HTTP ${reply.status}, expected 403`);
    });

    // -------------------------------------------------- 3. MCP as B
    section("3. MCP client with B's key");
    await check("B connects with only the URL and the key, and lists tools from every server", async () => {
      bClient = await connectMcp(members.B.key);
      const names = await toolNames(bClient);
      for (const expected of [`${SHOP}__list_orders`, `${FX}__convert`, `${NOTES}__create_note`]) {
        assert(names.includes(expected), `tool ${expected} is not listed (got ${names.length} tools)`);
      }
      assert(names.every((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n) && n.includes("__")), "a tool name is not namespaced <server>__<tool> or breaks the name rules");
    });

    await check("every server's server_info is listed under its own prefix (a real name collision, resolved)", async () => {
      assert(bClient, "B is not connected");
      const names = await toolNames(bClient);
      for (const slug of [SHOP, FX, NOTES]) assert(names.includes(`${slug}__server_info`), `${slug}__server_info is missing`);
    });

    await check(`B calls ${SHOP}__list_orders`, async () => {
      assert(bClient, "B is not connected");
      const r = await callTool(bClient, `${SHOP}__list_orders`, { period: "last_7_days" });
      assert(!r.isError, `list_orders failed: ${r.text}`);
      assert(Array.isArray(r.json.orders) && typeof r.json.matched === "number", "list_orders did not return {orders: [...], matched: n}");
    });

    await check(`two-server flow: ${FX}__convert -> ${NOTES}__create_note -> ${NOTES}__get_note`, async () => {
      assert(bClient, "B is not connected");
      const converted = await callTool(bClient, `${FX}__convert`, { amount: 100, from: "USD", to: "EUR" });
      assert(!converted.isError, `convert failed: ${converted.text}`);
      noteResult = converted.json.result;
      assert(typeof noteResult === "number" && noteResult > 0, `convert returned no usable result: ${converted.text}`);

      const created = await callTool(bClient, `${NOTES}__create_note`, { title: `smoke ${RUN}`, body: `100 USD = ${noteResult} EUR (written by the smoke test)` });
      assert(!created.isError, `create_note failed: ${created.text}`);
      noteId = created.json.created?.id;
      assert(typeof noteId === "number", "create_note returned no id");

      const fetched = await callTool(bClient, `${NOTES}__get_note`, { id: noteId });
      assert(!fetched.isError, `get_note failed: ${fetched.text}`);
      assert(String(fetched.json.note?.body).includes(String(noteResult)), "the note does not contain the converted amount: data did not flow from one server to the other");
    });

    await check(`A calls ${NOTES}__server_info (so A has audit rows too)`, async () => {
      aClient = await connectMcp(members.A.key);
      const r = await callTool(aClient, `${NOTES}__server_info`);
      assert(!r.isError && r.json.server?.name === "mcp-notes", `unexpected server_info answer: ${r.text}`);
    });

    // -------------------------------------------------- 4. revocation
    section("4. Revoking B");
    await check("admin revokes B's key", async () => {
      await must("POST", `/api/api-keys/${members.B.keyId}/revoke`, { cookie: admin, status: 204 });
    });
    await check("B's key is rejected on the very next request (HTTP 401)", async () => {
      const res = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${members.B.key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert(res.status === 401, `a revoked key got HTTP ${res.status}, expected 401`);
    });
    await check("B's already-open MCP connection fails on its next call", async () => {
      assert(bClient, "B is not connected");
      let failed = false;
      try {
        await bClient.listTools();
      } catch {
        failed = true;
      }
      assert(failed, "a revoked key still listed tools over an open connection");
    });
    await check("A's key is unaffected", async () => {
      assert(aClient, "A is not connected");
      assert((await toolNames(aClient)).length > 0, "A can no longer list tools");
    });

    // -------------------------------------------------- 5. disable a server
    section(`5. Disabling "${NOTES}"`);
    await check(`admin disables "${NOTES}"`, async () => {
      await must("PATCH", `/api/servers/${ids[NOTES]}`, { cookie: admin, body: { enabled: false } });
      notesDisabled = true;
    });
    await check(`its tools vanish from A's tool list, the others stay, and calling one is an error`, async () => {
      assert(aClient, "A is not connected");
      const client = aClient;
      await waitUntil(`no ${NOTES}__ tools in tools/list`, async () => !(await toolNames(client)).some((n) => n.startsWith(`${NOTES}__`)), 60_000);
      const names = await toolNames(client);
      assert(names.includes(`${SHOP}__list_orders`) && names.includes(`${FX}__convert`), "tools of the other servers disappeared too");
      const groups = await must<{ servers: { slug: string }[] }>("GET", "/api/tools", { cookie: members.A.cookie });
      assert(!groups.servers.some((g) => g.slug === NOTES), `/api/tools still lists "${NOTES}"`);
      const r = await callTool(client, `${NOTES}__server_info`);
      assert(r.isError, "calling a tool of a disabled server did not fail");
    });
    await check(`admin enables "${NOTES}" again and its tools return`, async () => {
      await must("PATCH", `/api/servers/${ids[NOTES]}`, { cookie: admin, body: { enabled: true } });
      notesDisabled = false;
      const client = aClient;
      assert(client, "A is not connected");
      await waitUntil(`${NOTES}__ tools back in tools/list`, async () => (await toolNames(client)).includes(`${NOTES}__create_note`), 90_000);
    });

    // -------------------------------------------------- 6. an upstream dies
    section(`6. Scaling ${FX_DEPLOYMENT} to 0`);
    await check(`kubectl can scale ${FX_DEPLOYMENT} to 0 replicas`, () => {
      kubectl("scale", `deploy/${FX_DEPLOYMENT}`, "--replicas=0");
      fxScaledDown = true;
    });
    await check(`"${FX}" becomes Unreachable (admin sees why; a member sees only the status)`, async () => {
      await waitUntil(`${FX} to be marked down`, async () => (await serverBySlug(admin, FX))?.status === "down", 120_000, 3_000);
      const asAdmin = await serverBySlug(admin, FX);
      assert(asAdmin?.lastError, "an Unreachable server has no last_error for the admin tooltip");
      const asMember = await serverBySlug(members.A.cookie, FX);
      assert(asMember?.status === "down" && asMember.lastError === null, "a member must see the status but never the error text");
    });
    await check(`the other servers still work (${SHOP}, ${NOTES})`, async () => {
      assert(aClient, "A is not connected");
      const orders = await callTool(aClient, `${SHOP}__list_orders`, { period: "today" });
      assert(!orders.isError, `list_orders failed while ${FX} was down: ${orders.text}`);
      const info = await callTool(aClient, `${NOTES}__server_info`);
      assert(!info.isError, `notes server_info failed while ${FX} was down: ${info.text}`);
    });
    await check(`"${FX}" tools are hidden and a call fails fast with a clear message`, async () => {
      assert(aClient, "A is not connected");
      assert(!(await toolNames(aClient)).some((n) => n.startsWith(`${FX}__`)), `${FX} tools are still listed while it is Unreachable`);
      const started = Date.now();
      const r = await callTool(aClient, `${FX}__convert`, { amount: 1, from: "USD", to: "EUR" });
      assert(r.isError && /unreachable/i.test(r.text), `expected an "unreachable" error, got: ${r.text}`);
      assert(Date.now() - started < 3_000, `the call took ${Date.now() - started} ms: it should fail immediately`);
    });
    await check(`scaling ${FX_DEPLOYMENT} back up: "${FX}" recovers and its tools return`, async () => {
      kubectl("scale", `deploy/${FX_DEPLOYMENT}`, "--replicas=1");
      fxScaledDown = false;
      const client = aClient;
      assert(client, "A is not connected");
      await waitUntil(`${FX} to be Connected again`, async () => (await serverBySlug(admin, FX))?.status === "up", 180_000, 3_000);
      await waitUntil(`${FX}__convert back in tools/list`, async () => (await toolNames(client)).includes(`${FX}__convert`), 30_000);
    });

    // -------------------------------------------------- 7. audit
    section("7. Audit log");
    type Entry = {
      createdAt: string;
      userEmail: string | null;
      keyName: string | null;
      keyPrefix: string | null;
      target: string | null;
      detail: { source: string; server: string | null; tool: string | null; durationMs: number; status: string; error: string | null } | null;
    };
    const auditFor = async (cookie: string, query = "") => (await must<{ entries: Entry[] }>("GET", `/api/audit?limit=200${query}`, { cookie })).entries;
    // Only this run's rows: filter by the unique emails.
    const rowsOf = (entries: Entry[], member: Member) => entries.filter((e) => e.userEmail === member.email);

    await check("B's four successful calls are audited: attributed to B and B's key, source mcp, status ok", async () => {
      const rows = rowsOf(await auditFor(admin), members.B);
      const expected = [`${SHOP}__list_orders`, `${FX}__convert`, `${NOTES}__create_note`, `${NOTES}__get_note`];
      for (const target of expected) {
        const matching = rows.filter((r) => r.target === target);
        assert(matching.length === 1, `expected exactly one audit row for ${target}, found ${matching.length}`);
        const row = matching[0] as Entry;
        assert(row.keyName === members.B.keyName && row.keyPrefix === members.B.key.slice(0, 12), `${target} is not attributed to B's key`);
        assert(row.detail?.source === "mcp" && row.detail.status === "ok", `${target}: expected source mcp / status ok, got ${row.detail?.source} / ${row.detail?.status}`);
        assert(row.detail.server === target.split("__")[0] && row.detail.tool === target.split("__")[1], `${target}: server/tool fields are wrong`);
        assert(typeof row.detail.durationMs === "number" && row.detail.durationMs >= 0, `${target}: no duration`);
        assert(new Date(row.createdAt).getTime() > STARTED_AT - 60_000, `${target}: timestamp is not from this run`);
      }
    });
    await check("nothing is attributed to B after the revocation (rejected requests make no tool call)", async () => {
      assert(rowsOf(await auditFor(admin), members.B).length === 4, "B has a different number of audit rows than the 4 successful calls it made");
    });
    await check("A's calls are attributed to A and A's key only, including the failures", async () => {
      const rows = rowsOf(await auditFor(admin), members.A);
      assert(rows.every((r) => r.keyName === members.A.keyName && r.keyPrefix === members.A.key.slice(0, 12)), "a row of A is attributed to a different key");
      assert(rows.filter((r) => r.target === `${NOTES}__server_info` && r.detail?.status === "ok").length >= 2, "A's successful notes server_info calls are missing");
      assert(rows.some((r) => r.target === `${SHOP}__list_orders` && r.detail?.status === "ok"), "A's list_orders call is missing");
      const down = rows.find((r) => r.target === `${FX}__convert` && r.detail?.status === "error");
      assert(down && /unreachable/i.test(down.detail?.error ?? ""), `the call made while ${FX} was down is not audited as an error`);
      const disabled = rows.find((r) => r.target === `${NOTES}__server_info` && r.detail?.status === "error");
      assert(disabled, "the call to the disabled server is not audited as an error");
    });
    await check("filtering by user returns only that user's rows", async () => {
      const rows = await auditFor(admin, `&userId=${members.B.id}`);
      assert(rows.length === 4 && rows.every((r) => r.userEmail === members.B.email), `filter by B returned ${rows.length} rows, some not B's`);
    });
    await check("a member sees only their own audit rows", async () => {
      const rows = await auditFor(members.A.cookie);
      assert(rows.length > 0 && rows.every((r) => r.userEmail === members.A.email), "a member's audit view contains someone else's rows");
    });
    await check("per-server summary has calls, error counts and latency for all three servers", async () => {
      const { servers } = await must<{ servers: { server: string; calls: number; errors: number; avgMs: number; p95Ms: number }[] }>("GET", "/api/audit/summary?hours=1", { cookie: admin });
      for (const slug of [SHOP, FX, NOTES]) {
        const row = servers.find((s) => s.server === slug);
        assert(row && row.calls > 0 && Number.isFinite(row.avgMs) && Number.isFinite(row.p95Ms), `no usable summary for ${slug}`);
      }
      assert((servers.find((s) => s.server === FX)?.errors ?? 0) >= 1, `the summary does not count the failed ${FX} call`);
    });
  } catch (err) {
    if (!(err instanceof Fatal)) throw err; // a Fatal was already reported by `check`
  } finally {
    // -------------------------------------------------- cleanup: always leave the platform as we found it
    section("Cleanup");
    await check("everything the test changed is put back", async () => {
      const problems: string[] = [];
      if (notesDisabled && ids[NOTES]) {
        await must("PATCH", `/api/servers/${ids[NOTES]}`, { cookie: admin, body: { enabled: true } }).catch((e: Error) => problems.push(`re-enabling ${NOTES}: ${e.message}`));
      }
      if (fxScaledDown) {
        try {
          kubectl("scale", `deploy/${FX_DEPLOYMENT}`, "--replicas=1");
        } catch (e) {
          problems.push(`scaling ${FX_DEPLOYMENT} back to 1: ${(e as Error).message}`);
        }
      }
      for (const m of Object.values(members)) {
        if (m.keyId && admin) await call("POST", `/api/api-keys/${m.keyId}/revoke`, { cookie: admin }); // idempotent
      }
      await Promise.allSettled([aClient?.close(), bClient?.close()]);
      assert(problems.length === 0, problems.join("; "));
    });
  }
}

main()
  .catch((err: unknown) => {
    console.log(`\n${red("Smoke test could not run:")} ${err instanceof Error ? err.message : String(err)}`);
    outcomes.push({ name: "smoke test ran", ok: false, reason: err instanceof Error ? err.message : String(err) });
  })
  .finally(() => {
    process.exit(printSummary() ? 0 : 1);
  });
