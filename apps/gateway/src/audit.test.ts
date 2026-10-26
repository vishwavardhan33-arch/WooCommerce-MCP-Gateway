import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiKey } from "./auth/apiKeys.js";
import { auditLog } from "./db/schema.js";
import { startHarness } from "./test/appHarness.js";

let h: Awaited<ReturnType<typeof startHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let alice: Awaited<ReturnType<typeof h.loginAs>>;
let bob: Awaited<ReturnType<typeof h.loginAs>>;

type Row = { server: string; tool: string; status: string; source?: string; ms: number; user: string; ago?: number; keyId?: string };

async function seed(r: Row) {
  await h.db.insert(auditLog).values({
    actorUserId: r.user,
    apiKeyId: r.keyId ?? null,
    action: "tool.call",
    target: `${r.server}__${r.tool}`,
    ok: r.status === "ok",
    createdAt: new Date(Date.now() - (r.ago ?? 1000)),
    detail: { source: r.source ?? "mcp", server: r.server, tool: r.tool, durationMs: r.ms, status: r.status, error: null, args: {} },
  });
}

beforeAll(async () => {
  h = await startHarness();
  admin = await h.loginAs("admin@example.com", "admin");
  alice = await h.loginAs("alice@example.com", "member");
  bob = await h.loginAs("bob@example.com", "member");
  const { apiKey } = await createApiKey(h.db, alice.user.id, "alice laptop");

  // shop: 5 calls by alice with latencies 100..400 and 1000 ms; one failed, one denied
  for (const [ms, status, ago] of [[100, "ok", 5000], [200, "ok", 4000], [300, "error", 3000], [400, "denied", 2000], [1000, "ok", 1000]] as const) {
    await seed({ server: "shop", tool: "list_products", status, ms, user: alice.user.id, ago, keyId: apiKey.id });
  }
  await seed({ server: "fx", tool: "convert", status: "ok", ms: 50, user: bob.user.id, source: "chat", ago: 500 });
  await seed({ server: "shop", tool: "get_order", status: "ok", ms: 10, user: bob.user.id, ago: 200 });
  await seed({ server: "shop", tool: "list_products", status: "ok", ms: 9999, user: alice.user.id, ago: 48 * 3_600_000 }); // two days old
}, 30_000);
afterAll(async () => {
  await h.close();
});

const entries = async (query: string, who: { cookie: string }) =>
  ((await (await h.call(`/api/audit${query}`, { cookie: who.cookie })).json()) as { entries: any[] }).entries; // eslint-disable-line @typescript-eslint/no-explicit-any
const summary = async (query: string, who: { cookie: string }) =>
  (await (await h.call(`/api/audit/summary${query}`, { cookie: who.cookie })).json()) as { servers: any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("GET /api/audit", () => {
  it("needs login", async () => {
    expect((await h.call("/api/audit")).status).toBe(401);
  });

  it("an admin sees every row, newest first, with who and which key", async () => {
    const rows = await entries("", admin);
    expect(rows).toHaveLength(8);
    expect(rows[0]?.target).toBe("shop__get_order"); // the most recent
    const withKey = rows.find((r) => r.keyName === "alice laptop");
    expect(withKey).toMatchObject({ userEmail: "alice@example.com", keyPrefix: expect.stringMatching(/^mcp_/) });
    expect(rows.find((r) => r.target === "fx__convert")?.keyName).toBeNull(); // chat: no key
  });

  it("a member sees only their own rows, even when asking for someone else's", async () => {
    const mine = await entries("", bob);
    expect(mine.map((r) => r.userEmail)).toEqual(["bob@example.com", "bob@example.com"]);
    const sneaky = await entries(`?userId=${alice.user.id}`, bob);
    expect(sneaky.every((r) => r.userEmail === "bob@example.com")).toBe(true);
  });

  it("filters by server, tool, status, source and (for admins) user", async () => {
    expect(await entries("?server=fx", admin)).toHaveLength(1);
    expect(await entries("?server=shop&tool=get_order", admin)).toHaveLength(1);
    expect(await entries("?status=error", admin)).toHaveLength(1);
    expect(await entries("?status=denied", admin)).toHaveLength(1);
    expect(await entries("?source=chat", admin)).toHaveLength(1);
    expect(await entries(`?userId=${alice.user.id}`, admin)).toHaveLength(6);
    expect(await entries(`?userId=${alice.user.id}&status=ok&server=shop`, admin)).toHaveLength(4);
    expect(await entries("?server=nothing", admin)).toHaveLength(0);
  });

  it("pages with limit and offset", async () => {
    const all = await entries("?limit=200", admin);
    const page = await entries("?limit=3&offset=2", admin);
    expect(page.map((r) => r.id)).toEqual(all.slice(2, 5).map((r) => r.id));
  });

  it("rejects bad parameters", async () => {
    expect((await h.call("/api/audit?status=weird", { cookie: admin.cookie })).status).toBe(400);
    expect((await h.call("/api/audit?limit=5000", { cookie: admin.cookie })).status).toBe(400);
    expect((await h.call("/api/audit?userId=nope", { cookie: admin.cookie })).status).toBe(400);
  });
});

describe("GET /api/audit/summary", () => {
  it("computes calls, errors, denied, average and 95th-percentile latency per server for the window", async () => {
    const { servers } = await summary("?hours=24", admin);
    const shop = servers.find((s) => s.server === "shop");
    // alice: 100,200,300,400,1000 (the 9999 ms row is two days old and excluded) + bob's get_order 10 ms
    expect(shop).toMatchObject({ calls: 6, errors: 1, denied: 1 });
    expect(shop.avgMs).toBe(335); // (100+200+300+400+1000+10) / 6
    expect(shop.p95Ms).toBe(850); // position 0.95 x 5 = 4.75 in the sorted 10,100,200,300,400,1000: 400 + 0.75 x 600
    expect(servers.find((s) => s.server === "fx")).toMatchObject({ calls: 1, errors: 0, avgMs: 50, p95Ms: 50 });
    expect(servers[0]?.server).toBe("shop"); // busiest first
  });

  it("a longer window includes older calls", async () => {
    const { servers } = await summary("?hours=72", admin);
    expect(servers.find((s) => s.server === "shop")?.calls).toBe(7);
  });

  it("a member's summary covers only their own calls", async () => {
    const { servers } = await summary("?hours=24", bob);
    expect(servers.map((s) => [s.server, s.calls]).sort()).toEqual([["fx", 1], ["shop", 1]]);
  });
});
