import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { asc } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createApiKey, revokeApiKey } from "../auth/apiKeys.js";
import type { AuthUser } from "../auth/types.js";
import type { Db } from "../db/client.js";
import { auditLog, mcpServers } from "../db/schema.js";
import { createTestDb, seedUser, testConfig } from "../test/helpers.js";
import { MockUpstream } from "../test/mockUpstream.js";
import { UpstreamManager } from "../upstream/manager.js";

// The whole path a real client takes: HTTP -> API key auth -> gateway server -> upstream manager ->
// a real upstream MCP server. The client below is the same SDK client MCP Inspector uses, given
// nothing but a URL and a key.
let db: Db;
let closeDb: () => Promise<void>;
let server: Server;
let base: string;
let upstream: MockUpstream;
let manager: UpstreamManager;
let user: AuthUser;
const logLines: string[] = [];

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  user = (await seedUser(db, "inspector@example.com", "member")) as AuthUser;

  upstream = new MockUpstream([
    { name: "list_products", description: "Lists products" },
    { name: "get_order", description: "Gets one order" },
  ]);
  await upstream.start();
  await db.insert(mcpServers).values({ slug: "shop", url: upstream.url, timeoutMs: 1000 });
  manager = new UpstreamManager({ db, logger: pino({ level: "silent" }), credentialKey: Buffer.alloc(32), allowedHosts: ["127.0.0.1"], healthIntervalMs: 3_600_000 });
  await manager.tick();

  // A logger that keeps what it writes, so the test can read the auth-failure logs.
  const logger = pino({ level: "info" }, { write: (line: string) => void logLines.push(line) });
  const app = createApp({ db, config: testConfig(), logger, upstreams: manager });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await manager.stop();
  await upstream.stop();
  await closeDb();
});

const connect = async (key: string) => {
  const client = new Client({ name: "inspector-like", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
};
const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("POST /mcp", () => {
  it("a client given only the URL and a key connects, lists every tool and calls one; the audit row is right", async () => {
    const { key, apiKey } = await createApiKey(db, user.id, "inspector");
    const client = await connect(key);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["shop__get_order", "shop__list_products"]);
      expect(tools.every((t) => t.description?.startsWith("[shop] "))).toBe(true);

      const result = await client.callTool({ name: "shop__get_order", arguments: { order_id: 42 } });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    const rows = await db.select().from(auditLog).orderBy(asc(auditLog.createdAt));
    const row = rows.find((r) => r.target === "shop__get_order");
    expect(row).toMatchObject({ actorUserId: user.id, apiKeyId: apiKey.id, action: "tool.call", ok: true });
    expect(row?.detail).toMatchObject({ source: "mcp", server: "shop", tool: "get_order", status: "ok", args: { order_id: 42 } });
  });

  it("a revoked key is rejected on the very next call, even on a connection that was already working", async () => {
    const { key, apiKey } = await createApiKey(db, user.id, "to be revoked");
    const client = await connect(key);
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);

      await revokeApiKey(db, user, apiKey.id);

      await expect(client.listTools()).rejects.toThrow(); // the next request gets 401
      await expect(client.callTool({ name: "shop__get_order", arguments: {} })).rejects.toThrow();
    } finally {
      await client.close().catch(() => undefined);
    }
    expect((await rpc(LIST, { Authorization: `Bearer ${key}` })).status).toBe(401);
  });

  it("answers 401 with a Bearer challenge and a JSON-RPC error for missing, malformed and unknown keys", async () => {
    for (const headers of [{}, { Authorization: "Basic abc" }, { Authorization: "Bearer not-a-key" }, { Authorization: `Bearer mcp_${"x".repeat(43)}` }]) {
      const res = await rpc(LIST, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      const body = (await res.json()) as { jsonrpc: string; error: { message: string } };
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error.message).toMatch(/Unauthorized/);
    }
  });

  it("logs every auth failure with the reason, and never the key itself", async () => {
    logLines.length = 0;
    const fake = `mcp_${"y".repeat(43)}`;
    await rpc(LIST);
    await rpc(LIST, { Authorization: `Bearer ${fake}` });

    const entries = logLines.map((l) => JSON.parse(l) as { msg?: string; reason?: string; keyPrefix?: string }).filter((e) => e.msg === "mcp auth failed");
    expect(entries.map((e) => e.reason)).toEqual(["missing_authorization_header", "unknown_or_revoked_key"]);
    expect(entries[1]?.keyPrefix).toBe(fake.slice(0, 12));
    expect(logLines.join("\n")).not.toContain(fake);
  });

  it("is stateless: GET and DELETE are 405 (after authentication), and no session id is issued", async () => {
    const { key } = await createApiKey(db, user.id, "stateless");
    const auth = { Authorization: `Bearer ${key}` };
    expect((await fetch(`${base}/mcp`, { method: "GET", headers: auth })).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: "DELETE", headers: auth })).status).toBe(405);
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, auth);
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("answers malformed JSON with a JSON-RPC parse error", async () => {
    const { key } = await createApiKey(db, user.id, "bad json");
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: "{oops" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
});
