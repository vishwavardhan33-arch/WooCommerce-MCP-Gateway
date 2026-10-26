import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptCredential } from "../crypto.js";
import type { Db } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import { MockUpstream, sleep, type MockTool } from "../test/mockUpstream.js";
import { createTestDb, silentLogger } from "../test/helpers.js";
import { UpstreamManager } from "./manager.js";

// The manager is tested against REAL MCP servers over real HTTP (test/mockUpstream.ts) and an
// in-memory Postgres. Timeouts are real but short (500 ms) to keep the suite quick.
const KEY = Buffer.from("0123456789abcdef".repeat(4), "hex");
const TIMEOUT_MS = 500;

let db: Db;
let closeDb: () => Promise<void>;
const mocks: MockUpstream[] = [];
const managers: UpstreamManager[] = [];

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
}, 30_000);

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
  await Promise.all(mocks.splice(0).map((m) => m.stop()));
  await db.delete(mcpServers);
});

afterAll(async () => {
  await closeDb();
});

const tool = (name: string, extra: Partial<MockTool> = {}): MockTool => ({ name, description: `${name} description`, ...extra });

async function newMock(tools: MockTool[]): Promise<MockUpstream> {
  const mock = new MockUpstream(tools);
  await mock.start();
  mocks.push(mock);
  return mock;
}

// 127.0.0.1 is a loopback address, which the SSRF guard blocks unless it is allowlisted, so the
// tests allowlist it by default (and one test leaves the list empty on purpose).
function newManager(opts: { allowedHosts?: string[]; healthIntervalMs?: number } = {}): UpstreamManager {
  const manager = new UpstreamManager({
    db,
    logger: silentLogger,
    credentialKey: KEY,
    allowedHosts: opts.allowedHosts ?? ["127.0.0.1"],
    healthIntervalMs: opts.healthIntervalMs ?? 3_600_000, // effectively "never": tests call tick() themselves
  });
  managers.push(manager);
  return manager;
}

const register = async (slug: string, mock: MockUpstream, extra: Partial<typeof mcpServers.$inferInsert> = {}) => {
  const [row] = await db.insert(mcpServers).values({ slug, url: mock.url, timeoutMs: TIMEOUT_MS, ...extra }).returning();
  return row;
};
const dbRow = async (slug: string) => (await db.select().from(mcpServers).where(eq(mcpServers.slug, slug)))[0];
const text = (result: { content?: unknown }) => JSON.stringify(result.content);
const names = (m: UpstreamManager) => m.listTools().map((t) => t.name);

describe("namespacing and collisions", () => {
  it("serves same-named tools from two servers under different names and routes each call to its own server", async () => {
    const alpha = await newMock([tool("search")]);
    const beta = await newMock([tool("search")]);
    await register("alpha", alpha);
    await register("beta", beta);
    const manager = newManager();
    await manager.tick();

    expect(names(manager).sort()).toEqual(["alpha__search", "beta__search"]);
    const alphaTool = manager.listTools().find((t) => t.name === "alpha__search");
    expect(alphaTool?.description).toBe("[alpha] search description");

    expect((await manager.callTool("beta__search")).isError).toBeFalsy();
    expect(beta.calls).toEqual(["search"]);
    expect(alpha.calls).toEqual([]);
  });

  it("keeps long and oddly named tools unique, valid, at most 64 characters, and callable under their ORIGINAL name", async () => {
    const longOne = `${"x".repeat(80)}_one`;
    const longTwo = `${"x".repeat(80)}_two`;
    const alpha = await newMock([tool(longOne), tool(longTwo), tool("a.b"), tool("a_b")]);
    await register("alpha", alpha);
    const manager = newManager();
    await manager.tick();

    const listed = names(manager);
    expect(listed).toHaveLength(4);
    expect(new Set(listed).size).toBe(4);
    for (const name of listed) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    // Calling every published name reaches the right upstream tool.
    for (const name of listed) expect((await manager.callTool(name)).isError).toBeFalsy();
    expect([...alpha.calls].sort()).toEqual([longOne, longTwo, "a.b", "a_b"].sort());
  });

  it("answers unknown servers and unknown tools with a clear isError result", async () => {
    const alpha = await newMock([tool("search")]);
    await register("alpha", alpha);
    const manager = newManager();
    await manager.tick();

    const noServer = await manager.callTool("ghost__search");
    expect(noServer.isError).toBe(true);
    expect(text(noServer)).toContain("alpha"); // lists the servers that do exist
    expect((await manager.callTool("no-separator")).isError).toBe(true);
    const noTool = await manager.callTool("alpha__missing");
    expect(noTool.isError).toBe(true);
    expect(text(noTool)).toContain("no tool");
  });
});

describe("timeouts and the circuit breaker", () => {
  it("a slow call returns an isError timeout after the per-server deadline; one failure does not open the breaker", async () => {
    const mock = await newMock([tool("fast"), tool("slow", { run: async () => (await sleep(3000), { content: [] }) })]);
    await register("shop", mock);
    const manager = newManager();
    await manager.tick();

    const started = Date.now();
    const result = await manager.callTool("shop__slow");
    expect(Date.now() - started).toBeLessThan(2000); // gave up near 500 ms, not after 3 s
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/timed out/);
    expect(text(result)).toMatch(/may still have been carried out/); // writes may have happened upstream

    expect(names(manager)).toContain("shop__fast"); // 1 failure: still up, tools still visible
    expect((await manager.callTool("shop__fast")).isError).toBeFalsy(); // and it reconnects and works
  });

  it("two failures open the breaker: tools are hidden and calls fail immediately without touching the server", async () => {
    const mock = await newMock([tool("fast"), tool("slow", { run: async () => (await sleep(3000), { content: [] }) })]);
    await register("shop", mock);
    const manager = newManager();
    await manager.tick();

    await manager.callTool("shop__slow");
    await manager.callTool("shop__slow"); // second consecutive failure
    expect(names(manager)).toEqual([]); // tools hidden
    expect((await dbRow("shop"))?.status).toBe("down");

    const requestsBefore = mock.requests;
    const started = Date.now();
    const result = await manager.callTool("shop__fast");
    expect(Date.now() - started).toBeLessThan(100); // fail fast: no waiting for a timeout
    expect(mock.requests).toBe(requestsBefore); // and no request was even sent
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/unreachable/);
  });

  it("an upstream tool that reports its own error is a working server: the breaker stays closed", async () => {
    const mock = await newMock([tool("boom", { run: () => ({ isError: true, content: [{ type: "text", text: "store says no" }] }) })]);
    await register("shop", mock);
    const manager = newManager();
    await manager.tick();

    for (let i = 0; i < 3; i++) {
      const result = await manager.callTool("shop__boom");
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("store says no"); // passed through untouched
    }
    expect(names(manager)).toEqual(["shop__boom"]);
    expect((await dbRow("shop"))?.status).toBe("up");
  });
});

describe("listing is never blocked by a slow upstream", () => {
  it("a hung server does not delay the others, and listing itself is instant", async () => {
    const healthy = await newMock([tool("search")]);
    const hung = await newMock([tool("search")]);
    hung.delayMs = 5000;
    await register("healthy", healthy);
    await register("hung", hung, { timeoutMs: 400 });
    const manager = newManager();

    await manager.tick(); // both are probed concurrently; the hung one gives up after 400 ms
    expect(names(manager)).toEqual(["healthy__search"]);

    const started = Date.now();
    manager.listTools();
    expect(Date.now() - started).toBeLessThan(20); // reads the cache only
  });

  it("refreshAll reports each server's outcome separately (allSettled)", async () => {
    const healthy = await newMock([tool("search")]);
    await register("healthy", healthy);
    await register("dead", healthy, { url: "http://127.0.0.1:1/mcp" }); // nothing listens on port 1
    const manager = newManager({ allowedHosts: ["127.0.0.1"] });
    await manager.tick();
    const results = await manager.refreshAll();
    expect(results.every((r) => r.status === "fulfilled")).toBe(true); // failures are recorded, never thrown
    expect(names(manager)).toEqual(["healthy__search"]);
  });
});

describe("dead server and recovery", () => {
  it("a crashed server goes down after two failed checks, its status is stored, and it comes back by itself", async () => {
    const mock = await newMock([tool("search")]);
    await register("shop", mock);
    const manager = newManager();
    await manager.tick();
    expect(names(manager)).toEqual(["shop__search"]);
    expect((await dbRow("shop"))?.status).toBe("up");

    await mock.stop();
    await manager.tick(); // failure 1: not down yet
    expect(names(manager)).toEqual(["shop__search"]);
    await manager.tick(); // failure 2: breaker opens
    expect(names(manager)).toEqual([]);
    const down = await dbRow("shop");
    expect(down?.status).toBe("down");
    expect(down?.lastError).toBeTruthy();
    const downSince = down?.statusSince;

    await manager.tick(); // still dead: stays down and status_since does not move
    expect((await dbRow("shop"))?.statusSince).toEqual(downSince);

    await mock.start(); // recovery
    await manager.tick();
    expect(names(manager)).toEqual(["shop__search"]);
    const back = await dbRow("shop");
    expect(back?.status).toBe("up");
    expect(back?.lastError).toBeNull();
    expect((await manager.callTool("shop__search")).isError).toBeFalsy();
  });

  it("a server that recovers from being slow comes back too", async () => {
    const mock = await newMock([tool("search")]);
    await register("shop", mock);
    const manager = newManager();
    await manager.tick();

    mock.delayMs = 3000;
    await manager.tick();
    await manager.tick();
    expect(names(manager)).toEqual([]);

    mock.delayMs = 0;
    await manager.tick();
    expect(names(manager)).toEqual(["shop__search"]);
  });

  it("the background loop does the probing by itself", async () => {
    const mock = await newMock([tool("search")]);
    await register("shop", mock);
    const manager = newManager({ healthIntervalMs: 100 });
    await manager.start();
    await vi.waitFor(() => expect(names(manager)).toEqual(["shop__search"]), { timeout: 3000 });

    await mock.stop();
    await vi.waitFor(() => expect(names(manager)).toEqual([]), { timeout: 5000 });
    await mock.start();
    await vi.waitFor(() => expect(names(manager)).toEqual(["shop__search"]), { timeout: 5000 });
  });
});

describe("session expiry", () => {
  it("reconnects automatically and the caller never notices", async () => {
    const mock = await newMock([tool("search")]);
    await register("shop", mock);
    const manager = newManager();
    await manager.tick();
    expect(mock.sessionsCreated).toBe(1);

    mock.expireSessions(); // the server forgets us; our next request gets 404
    const result = await manager.callTool("shop__search");

    expect(result.isError).toBeFalsy();
    expect(mock.sessionsCreated).toBe(2); // a new session was opened
    expect((await dbRow("shop"))?.status).toBe("up"); // and it was not counted as a failure
  });
});

describe("authentication", () => {
  it("sends the decrypted bearer credential", async () => {
    const mock = await newMock([tool("search")]);
    mock.token = "s3cret-token-value";
    await register("shop", mock, { authType: "bearer", credentialEnc: encryptCredential(KEY, "s3cret-token-value") });
    const manager = newManager();
    await manager.tick();
    expect(names(manager)).toEqual(["shop__search"]);
  });

  it("a wrong credential marks the server down, with an error that does not contain the credential", async () => {
    const mock = await newMock([tool("search")]);
    mock.token = "the-real-token";
    await register("shop", mock, { authType: "bearer", credentialEnc: encryptCredential(KEY, "wrong-token-xyz") });
    const manager = newManager();
    await manager.tick();
    await manager.tick();

    const row = await dbRow("shop");
    expect(row?.status).toBe("down");
    expect(row?.lastError).toMatch(/401|unauthor/i);
    expect(row?.lastError).not.toContain("wrong-token-xyz");
    expect(row?.lastError).not.toContain("the-real-token");
  });

  it("bearer auth without a stored credential is a clear configuration error", async () => {
    const mock = await newMock([tool("search")]);
    await register("shop", mock, { authType: "bearer", credentialEnc: null });
    const manager = newManager();
    await manager.tick();
    await manager.tick();
    expect((await dbRow("shop"))?.lastError).toMatch(/no stored credential/);
  });
});

describe("SSRF guard inside the manager", () => {
  it("never connects to an internal address that is not allowlisted", async () => {
    const mock = await newMock([tool("search")]);
    await register("shop", mock);
    const manager = newManager({ allowedHosts: [] });
    await manager.tick();
    await manager.tick();

    expect(mock.requests).toBe(0); // blocked before any connection
    const row = await dbRow("shop");
    expect(row?.status).toBe("down");
    expect(row?.lastError).toMatch(/UPSTREAM_ALLOWED_HOSTS/);
  });
});

describe("following the database", () => {
  it("starts enabled servers, ignores disabled ones, and reacts to enabling and disabling", async () => {
    const mock = await newMock([tool("search")]);
    const row = await register("shop", mock, { enabled: false });
    const manager = newManager();

    await manager.tick();
    expect(names(manager)).toEqual([]); // disabled: no client at all
    expect(mock.requests).toBe(0);

    await db.update(mcpServers).set({ enabled: true }).where(eq(mcpServers.id, row.id));
    await manager.tick();
    expect(names(manager)).toEqual(["shop__search"]);

    await db.update(mcpServers).set({ enabled: false }).where(eq(mcpServers.id, row.id));
    await manager.tick();
    expect(names(manager)).toEqual([]);
    expect((await dbRow("shop"))?.status).toBe("unknown"); // stored status reset, not left as a stale "up"
  });

  it("skips a server whose slug would break routing", async () => {
    const mock = await newMock([tool("search")]);
    await register("bad__slug", mock);
    const manager = newManager();
    await manager.tick();
    expect(names(manager)).toEqual([]);
    expect(mock.requests).toBe(0);
  });
});
