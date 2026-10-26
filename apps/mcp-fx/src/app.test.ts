import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { StaticRates } from "./fx/staticRates.js";

const TOKEN = "test-token-0123456789";
let server: Server;
let base: string;
let shuttingDown = false;

beforeAll(async () => {
  const app = createApp({ authToken: TOKEN, ctx: { rates: new StaticRates(), logger: pino({ level: "silent" }) }, isShuttingDown: () => shuttingDown });
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
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
  it("rejects a missing, wrong or scheme-less token", async () => {
    const missing = await rpc("tools/list", {}, null);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    expect((await rpc("tools/list", {}, TOKEN + "x")).status).toBe(401);
    const bare = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: TOKEN, "Content-Type": "application/json" }, body: "{}" });
    expect(bare.status).toBe(401);
  });
});

describe("stateless MCP over Streamable HTTP", () => {
  it("answers initialize and issues no session id", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect((((await res.json()) as Rpc).result?.serverInfo as { name: string }).name).toBe("mcp-fx");
  });

  it("lists the tools on every request, with no session and no prior initialize", async () => {
    for (let i = 0; i < 2; i++) {
      const body = (await (await rpc("tools/list", {})).json()) as Rpc;
      expect((body.result?.tools as { name: string }[]).map((t) => t.name).sort()).toEqual(["convert", "get_rate", "server_info"]);
    }
  });

  it("converts through a tool call", async () => {
    const res = await rpc("tools/call", { name: "convert", arguments: { amount: 100, from: "USD", to: "EUR" } });
    const content = ((await res.json()) as Rpc).result?.content as { text: string }[];
    expect(JSON.parse(content[0]?.text ?? "{}")).toMatchObject({ result: 92.5926, source: "static" });
  });

  it("answers GET and DELETE with 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      expect((await fetch(`${base}/mcp`, { method, headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    }
  });

  it("answers malformed JSON with a JSON-RPC parse error", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN}` }, body: "{not json" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Rpc).error?.code).toBe(-32700);
  });
});
