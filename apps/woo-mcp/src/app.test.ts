import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createFakeWc, KOLKATA_ORDERS } from "./test/fakeWc.js";
import { WcClient } from "./wc/client.js";

const TOKEN = "test-token-0123456789";
const fake = createFakeWc({ timezoneString: "Asia/Kolkata", orders: KOLKATA_ORDERS });
let server: Server;
let base: string;
let shuttingDown = false;

beforeAll(async () => {
  const wc = new WcClient({ baseUrl: "http://store.test", username: fake.username, appPassword: fake.password, timeoutMs: 2000, fetchImpl: fake.fetchImpl });
  const app = createApp({
    authToken: TOKEN,
    ctx: { wc, logger: pino({ level: "silent" }), now: () => new Date("2026-10-09T20:00:00Z") },
    isShuttingDown: () => shuttingDown,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } };

// Streamable HTTP clients must accept both JSON and event streams, or the transport answers 406.
const rpc = (method: string, params: unknown, token: string | null = TOKEN) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

describe("probes", () => {
  it("/healthz and /readyz need no token", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it("/readyz fails while shutting down, /healthz stays up", async () => {
    shuttingDown = true;
    try {
      expect((await fetch(`${base}/readyz`)).status).toBe(503);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    } finally {
      shuttingDown = false;
    }
  });
});

describe("bearer authentication on /mcp", () => {
  it("rejects a missing token and never reaches the store", async () => {
    fake.calls.length = 0;
    const res = await rpc("tools/list", {}, null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects a wrong token", async () => {
    expect((await rpc("tools/list", {}, "not-the-token-at-all")).status).toBe(401);
    expect((await rpc("tools/list", {}, TOKEN + "x")).status).toBe(401);
  });

  it("rejects a token sent without the Bearer scheme", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: TOKEN, "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});

describe("stateless MCP over Streamable HTTP", () => {
  it("answers initialize and issues no session id", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as Rpc;
    expect((body.result!.serverInfo as { name: string }).name).toBe("woo-mcp");
  });

  it("lists the tools on a request that has no session and no prior initialize", async () => {
    const body = (await (await rpc("tools/list", {})).json()) as Rpc;
    expect((body.result!.tools as unknown[]).length).toBe(7);
    // ...and again: every request is served by a brand-new server, so it works every time.
    const again = (await (await rpc("tools/list", {})).json()) as Rpc;
    expect((again.result!.tools as unknown[]).length).toBe(7);
  });

  it("creates a product through a tool call", async () => {
    const res = await rpc("tools/call", { name: "create_product", arguments: { name: "Inspector Mug", price: 9.99 } });
    const body = (await res.json()) as Rpc;
    const content = body.result!.content as { text: string }[];
    expect(JSON.parse(content[0]!.text).created.name).toBe("Inspector Mug");
    expect(fake.products.some((p) => p.name === "Inspector Mug")).toBe(true);
  });

  it("answers GET and DELETE with 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${base}/mcp`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(405);
    }
  });

  it("answers malformed JSON with a JSON-RPC parse error", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Rpc).error!.code).toBe(-32700);
  });
});
