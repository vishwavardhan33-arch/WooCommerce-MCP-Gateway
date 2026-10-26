import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { NotesStore, openDatabase } from "./notes/store.js";

const TOKEN = "test-token-0123456789";
const db = openDatabase(":memory:");
let server: Server;
let base: string;
let shuttingDown = false;

beforeAll(async () => {
  const app = createApp({
    authToken: TOKEN,
    ctx: { store: new NotesStore(db), logger: pino({ level: "silent" }), now: () => new Date("2026-10-12T09:00:00Z") },
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

  it("/readyz fails when the database is unusable, while /healthz stays up", async () => {
    const broken = openDatabase(":memory:");
    const app = createApp({ authToken: TOKEN, ctx: { store: new NotesStore(broken), logger: pino({ level: "silent" }), now: () => new Date() } });
    broken.close();
    const s = await new Promise<Server>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
    });
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      const ready = await fetch(`${url}/readyz`);
      expect(ready.status).toBe(503);
      expect(((await ready.json()) as { status: string }).status).toBe("database_unavailable");
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
    } finally {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});

describe("bearer authentication on /mcp", () => {
  it("rejects a missing, wrong or scheme-less token, and does not touch the database", async () => {
    const missing = await rpc("tools/call", { name: "create_note", arguments: { title: "t", body: "b" } }, null);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    expect((await rpc("tools/list", {}, TOKEN + "x")).status).toBe(401);
    const bare = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: TOKEN, "Content-Type": "application/json" }, body: "{}" });
    expect(bare.status).toBe(401);
    expect(db.prepare("SELECT count(*) AS n FROM notes").get()).toEqual({ n: 0 });
  });
});

describe("stateless MCP over Streamable HTTP", () => {
  it("answers initialize and issues no session id", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect((((await res.json()) as Rpc).result?.serverInfo as { name: string }).name).toBe("mcp-notes");
  });

  it("lists the tools on every request, with no session and no prior initialize", async () => {
    for (let i = 0; i < 2; i++) {
      const body = (await (await rpc("tools/list", {})).json()) as Rpc;
      expect((body.result?.tools as unknown[]).length).toBe(5);
    }
  });

  it("notes written by one request are visible to the next (state lives in SQLite, not in the server)", async () => {
    await rpc("tools/call", { name: "create_note", arguments: { title: "Over HTTP", body: "persisted in sqlite" } });
    const res = await rpc("tools/call", { name: "search_notes", arguments: { query: "persisted" } });
    const content = ((await res.json()) as Rpc).result?.content as { text: string }[];
    expect(JSON.parse(content[0]?.text ?? "{}").count).toBe(1);
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
