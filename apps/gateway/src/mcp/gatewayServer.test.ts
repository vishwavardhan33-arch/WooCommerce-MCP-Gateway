import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApiKey } from "../auth/apiKeys.js";
import type { Db } from "../db/client.js";
import { auditLog, mcpServers, toolPolicies } from "../db/schema.js";
import { createTestDb, seedUser, silentLogger } from "../test/helpers.js";
import { MockUpstream, sleep, type MockTool } from "../test/mockUpstream.js";
import { UpstreamManager } from "../upstream/manager.js";
import { createGatewayServer } from "./gatewayServer.js";
import type { Principal } from "./principal.js";

// createGatewayServer is tested without HTTP: a Client talks to it over an in-memory pipe, which
// is also exactly how the chat agent will use it.
let db: Db;
let closeDb: () => Promise<void>;
let principal: Principal;
const mocks: MockUpstream[] = [];
const managers: UpstreamManager[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  const user = await seedUser(db, "agent@example.com", "member");
  const { apiKey } = await createApiKey(db, user?.id ?? "", "test key");
  principal = { userId: user?.id ?? "", role: "member", apiKeyId: apiKey.id, source: "mcp" };
}, 30_000);

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(managers.splice(0).map((m) => m.stop()));
  await Promise.all(mocks.splice(0).map((m) => m.stop()));
  await db.delete(mcpServers); // tool_policies go with it (ON DELETE CASCADE)
  await db.delete(auditLog);
});

afterAll(async () => {
  await closeDb();
});

const tool = (name: string, extra: Partial<MockTool> = {}): MockTool => ({ name, description: `${name} description`, ...extra });

async function setup(servers: Record<string, MockTool[]>, who: Principal = principal) {
  const registered: Record<string, { mock: MockUpstream; id: string }> = {};
  for (const [slug, tools] of Object.entries(servers)) {
    const mock = new MockUpstream(tools);
    await mock.start();
    mocks.push(mock);
    const [row] = await db.insert(mcpServers).values({ slug, url: mock.url, timeoutMs: 500 }).returning();
    registered[slug] = { mock, id: row?.id ?? "" };
  }
  const upstreams = new UpstreamManager({ db, logger: silentLogger, credentialKey: Buffer.alloc(32), allowedHosts: ["127.0.0.1"], healthIntervalMs: 3_600_000 });
  managers.push(upstreams);
  await upstreams.tick();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createGatewayServer(who, { db, logger: silentLogger, upstreams }).connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return { client, registered, upstreams };
}

const audit = async () => db.select().from(auditLog).orderBy(asc(auditLog.createdAt));
interface Detail {
  source: string;
  server: string | null;
  tool: string | null;
  durationMs: number;
  status: string;
  error: string | null;
  args: Record<string, unknown>;
}
const text = (r: { content?: unknown }) => JSON.stringify(r.content);

describe("tools/list", () => {
  it("lists every tool of every healthy server, namespaced and prefixed", async () => {
    const { client } = await setup({ shop: [tool("list_products"), tool("get_order")], blog: [tool("list_posts")] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["blog__list_posts", "shop__get_order", "shop__list_products"]);
    expect(tools.find((t) => t.name === "shop__get_order")?.description).toBe("[shop] get_order description");
  });

  it("hides a tool an administrator disabled, and keeps the rest", async () => {
    const { client, registered } = await setup({ shop: [tool("list_products"), tool("delete_everything")] });
    await db.insert(toolPolicies).values({ serverId: registered.shop?.id ?? "", toolName: "delete_everything", enabled: false });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["shop__list_products"]);
  });

  it("an enabled=true policy row changes nothing", async () => {
    const { client, registered } = await setup({ shop: [tool("list_products")] });
    await db.insert(toolPolicies).values({ serverId: registered.shop?.id ?? "", toolName: "list_products", enabled: true });
    expect((await client.listTools()).tools).toHaveLength(1);
  });

  it("is not blocked by a hung upstream and does not audit", async () => {
    const { client, registered } = await setup({ shop: [tool("list_products")], hung: [tool("x")] });
    if (registered.hung) registered.hung.mock.delayMs = 5000; // from now on probing it would hang
    const started = Date.now();
    const { tools } = await client.listTools();
    expect(Date.now() - started).toBeLessThan(500); // answered from the cache
    expect(tools.length).toBeGreaterThan(0);
    expect(await audit()).toHaveLength(0);
  });
});

describe("tools/call: permissions", () => {
  it("rejects a disabled tool even when the client calls it by name, and never contacts the upstream", async () => {
    const { client, registered } = await setup({ shop: [tool("list_products"), tool("delete_everything")] });
    await db.insert(toolPolicies).values({ serverId: registered.shop?.id ?? "", toolName: "delete_everything", enabled: false });

    const result = await client.callTool({ name: "shop__delete_everything", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/disabled by an administrator/);
    expect(registered.shop?.mock.calls).toEqual([]); // never reached the server

    const [row] = await audit();
    expect((row?.detail as Detail).status).toBe("denied");
    expect(row?.ok).toBe(false);
  });

  it("an allowed tool next to a disabled one still works", async () => {
    const { client, registered } = await setup({ shop: [tool("list_products"), tool("delete_everything")] });
    await db.insert(toolPolicies).values({ serverId: registered.shop?.id ?? "", toolName: "delete_everything", enabled: false });
    const result = await client.callTool({ name: "shop__list_products", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(registered.shop?.mock.calls).toEqual(["list_products"]);
  });

  it("a policy change applies on the very next call", async () => {
    const { client, registered } = await setup({ shop: [tool("list_products")] });
    expect((await client.callTool({ name: "shop__list_products", arguments: {} })).isError).toBeFalsy();
    await db.insert(toolPolicies).values({ serverId: registered.shop?.id ?? "", toolName: "list_products", enabled: false });
    expect((await client.callTool({ name: "shop__list_products", arguments: {} })).isError).toBe(true);
  });
});

describe("tools/call: audit records", () => {
  it("writes one correct row for a successful call", async () => {
    const { client } = await setup({ shop: [tool("list_products", { run: async () => (await sleep(50), { content: [{ type: "text", text: "3 products" }] }) })] });
    const result = await client.callTool({ name: "shop__list_products", arguments: { limit: 3 } });
    expect(text(result)).toContain("3 products");

    const rows = await audit();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.actorUserId).toBe(principal.userId);
    expect(row?.apiKeyId).toBe(principal.apiKeyId);
    expect(row?.action).toBe("tool.call");
    expect(row?.target).toBe("shop__list_products");
    expect(row?.ok).toBe(true);
    const detail = row?.detail as Detail;
    expect(detail).toMatchObject({ source: "mcp", server: "shop", tool: "list_products", status: "ok", error: null, args: { limit: 3 } });
    expect(detail.durationMs).toBeGreaterThanOrEqual(40); // the tool slept 50 ms
    expect(detail.durationMs).toBeLessThan(2000);
  });

  it("records a tool-reported error with a truncated message", async () => {
    const long = "boom ".repeat(200); // 1000 characters
    const { client } = await setup({ shop: [tool("fails", { run: () => ({ isError: true, content: [{ type: "text", text: long }] }) })] });
    const result = await client.callTool({ name: "shop__fails", arguments: {} });
    expect(result.isError).toBe(true);

    const [row] = await audit();
    const detail = row?.detail as Detail;
    expect(row?.ok).toBe(false);
    expect(detail.status).toBe("error");
    expect(detail.error?.startsWith("boom boom")).toBe(true);
    expect(detail.error?.length).toBeLessThanOrEqual(303); // 300 characters + "..."
  });

  it("redacts the arguments: shapes only, secrets replaced, no text copied", async () => {
    const { client } = await setup({ shop: [tool("create_customer")] });
    await client.callTool({
      name: "shop__create_customer",
      arguments: { email: "alice@example.com", password: "hunter2", note: "call after 5pm", count: 3, tags: ["a", "b"], address: { city: "x" } },
    });
    const [row] = await audit();
    expect((row?.detail as Detail).args).toEqual({
      email: "string(17)",
      password: "[redacted]",
      note: "string(14)",
      count: 3,
      tags: "array(2)",
      address: "object(1 keys)",
    });
    const stored = JSON.stringify(row);
    for (const secret of ["alice@example.com", "hunter2", "call after 5pm"]) expect(stored).not.toContain(secret);
  });

  it("records calls to unknown tools and unknown servers, with no server or tool filled in", async () => {
    const { client } = await setup({ shop: [tool("list_products")] });
    expect((await client.callTool({ name: "ghost__anything", arguments: {} })).isError).toBe(true);
    expect((await client.callTool({ name: "shop__missing", arguments: {} })).isError).toBe(true);

    const rows = await audit();
    expect(rows).toHaveLength(2);
    const ghost = rows.find((r) => r.target === "ghost__anything")?.detail as Detail;
    expect(ghost).toMatchObject({ server: null, tool: null, status: "error" });
    const missing = rows.find((r) => r.target === "shop__missing")?.detail as Detail;
    expect(missing).toMatchObject({ server: "shop", tool: null, status: "error" });
  });

  it("records a dead upstream's fail-fast error", async () => {
    const { client, upstreams, registered } = await setup({ shop: [tool("list_products")] });
    await registered.shop?.mock.stop();
    await upstreams.tick();
    await upstreams.tick(); // breaker opens
    await db.delete(auditLog);

    const result = await client.callTool({ name: "shop__list_products", arguments: {} });
    expect(result.isError).toBe(true);
    const [row] = await audit();
    expect(row?.ok).toBe(false);
    expect((row?.detail as Detail).error).toMatch(/unreachable/);
  });

  it("the chat agent's calls are recorded with source 'chat' and no API key", async () => {
    const chat: Principal = { ...principal, apiKeyId: null, source: "chat" };
    const { client } = await setup({ shop: [tool("list_products")] }, chat);
    await client.callTool({ name: "shop__list_products", arguments: {} });
    const [row] = await audit();
    expect(row?.apiKeyId).toBeNull();
    expect(row?.actorUserId).toBe(principal.userId);
    expect((row?.detail as Detail).source).toBe("chat");
  });

  it("a failing audit write does not break the call", async () => {
    const { client } = await setup({ shop: [tool("list_products")] });
    await db.execute(sql`alter table audit_log rename to audit_log_off`);
    try {
      const result = await client.callTool({ name: "shop__list_products", arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await db.execute(sql`alter table audit_log_off rename to audit_log`);
    }
    expect(await db.select().from(auditLog).where(eq(auditLog.target, "shop__list_products"))).toHaveLength(0);
  });
});
