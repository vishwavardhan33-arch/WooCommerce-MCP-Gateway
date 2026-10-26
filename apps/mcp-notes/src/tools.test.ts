import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { NotesStore, openDatabase } from "./notes/store.js";
import { createMcpServer } from "./server.js";

// The real MCP server and the real MCP client over an in-memory pipe, with an in-memory SQLite
// database and a fixed clock.
const NOW = new Date("2026-10-12T09:00:00.000Z");
type Json = Record<string, unknown>;

async function setup() {
  const store = new NotesStore(openDatabase(":memory:"));
  const server = createMcpServer({ store, logger: pino({ level: "silent" }), now: () => NOW });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  async function call(name: string, args: Json = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    return { isError: res.isError === true, text, data: (res.isError ? {} : JSON.parse(text)) as Json };
  }
  // Invalid arguments may surface as an isError result or as a protocol-level InvalidParams error,
  // depending on the SDK version; either way the call must NOT succeed.
  async function isRejected(name: string, args: Json): Promise<boolean> {
    try {
      return (await client.callTool({ name, arguments: args })).isError === true;
    } catch {
      return true;
    }
  }
  return { client, store, call, isRejected };
}

const created = (data: Json) => (data.created as { id: number }).id;

describe("tool list", () => {
  it("exposes the four note tools and server_info with honest annotations", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["create_note", "get_note", "list_notes", "search_notes", "server_info"]);
    const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;
    for (const readOnly of ["list_notes", "get_note", "search_notes", "server_info"]) expect(hints(readOnly)?.readOnlyHint).toBe(true);
    expect(hints("create_note")?.readOnlyHint).toBe(false);
    expect(hints("create_note")?.destructiveHint).toBe(false);
    expect(hints("create_note")?.idempotentHint).toBe(false);
  });
});

describe("create_note and get_note", () => {
  it("creates a note stamped with the clock and returns it in full by id", async () => {
    const { call } = await setup();
    const made = await call("create_note", { title: "  Shopping  ", body: "milk\neggs" });
    expect(made.data.created).toMatchObject({ title: "Shopping", created_at: NOW.toISOString() }); // title is trimmed
    const got = await call("get_note", { id: created(made.data) });
    expect(got.data.note).toMatchObject({ title: "Shopping", body: "milk\neggs", created_at: NOW.toISOString() });
  });

  it("calling create_note twice makes two notes (it is not idempotent)", async () => {
    const { call, store } = await setup();
    await call("create_note", { title: "Same", body: "same" });
    await call("create_note", { title: "Same", body: "same" });
    expect(store.count()).toBe(2);
  });

  it("get_note on a missing id is a clear isError result", async () => {
    const { call } = await setup();
    const r = await call("get_note", { id: 42 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no note with id 42");
  });

  it("rejects bad input without touching the database", async () => {
    const { isRejected, store } = await setup();
    const bad: Json[] = [{ title: "", body: "x" }, { title: "   ", body: "x" }, { title: "t", body: "" }, { title: "x".repeat(201), body: "b" }, { title: "t", body: "x".repeat(10_001) }, { title: "t" }];
    for (const args of bad) expect(await isRejected("create_note", args)).toBe(true);
    expect(await isRejected("get_note", { id: 0 })).toBe(true);
    expect(await isRejected("get_note", { id: 1.5 })).toBe(true);
    expect(await isRejected("get_note", { id: "1" })).toBe(true);
    expect(store.count()).toBe(0);
  });
});

describe("list_notes", () => {
  it("lists newest first with a short preview, and says when there may be more", async () => {
    const { call } = await setup();
    for (let i = 1; i <= 3; i++) await call("create_note", { title: `Note ${i}`, body: "y".repeat(300) });
    const all = await call("list_notes", {});
    expect((all.data.notes as { title: string; preview: string }[]).map((n) => n.title)).toEqual(["Note 3", "Note 2", "Note 1"]);
    expect((all.data.notes as { preview: string }[])[0]?.preview).toHaveLength(100);
    expect(all.data.note).toBeUndefined();

    const page = await call("list_notes", { limit: 2 });
    expect(page.data.count).toBe(2);
    expect(page.data.note).toContain("offset");
    const next = await call("list_notes", { limit: 2, offset: 2 });
    expect((next.data.notes as { title: string }[]).map((n) => n.title)).toEqual(["Note 1"]);
  });

  it("rejects out-of-range limits and offsets", async () => {
    const { isRejected } = await setup();
    for (const args of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { limit: 1.5 }]) expect(await isRejected("list_notes", args)).toBe(true);
  });
});

describe("search_notes", () => {
  it("finds notes by title or body, ignoring case", async () => {
    const { call } = await setup();
    await call("create_note", { title: "Groceries", body: "milk and eggs" });
    await call("create_note", { title: "Meeting", body: "Plan Q4 with Alice" });
    const hit = await call("search_notes", { query: "ALICE" });
    expect((hit.data.notes as { title: string }[]).map((n) => n.title)).toEqual(["Meeting"]);
    const none = await call("search_notes", { query: "zebra" });
    expect(none.data).toMatchObject({ count: 0, notes: [] });
    expect(none.isError).toBe(false); // no match is an answer, not an error
  });

  it("rejects an empty query", async () => {
    const { isRejected } = await setup();
    expect(await isRejected("search_notes", { query: "   " })).toBe(true);
    expect(await isRejected("search_notes", {})).toBe(true);
  });
});

describe("database failures", () => {
  it("a broken database becomes an isError result and the server keeps answering", async () => {
    const { call, store } = await setup();
    store.create = () => {
      throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    };
    const r = await call("create_note", { title: "t", body: "b" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("SQLITE_FULL");
    expect((await call("list_notes", {})).isError).toBe(false); // reads still work
  });
});

describe("server_info", () => {
  it("reports name, version and how many notes it holds", async () => {
    const { call } = await setup();
    await call("create_note", { title: "t", body: "b" });
    const { data } = await call("server_info");
    expect(data.server).toEqual({ name: "mcp-notes", version: "0.1.0" });
    expect(data.notes).toEqual({ count: 1 });
  });
});
