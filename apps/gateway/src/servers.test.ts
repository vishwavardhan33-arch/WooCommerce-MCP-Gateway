import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decryptCredential } from "./crypto.js";
import { mcpServers, toolPolicies } from "./db/schema.js";
import { startHarness } from "./test/appHarness.js";
import { MockUpstream } from "./test/mockUpstream.js";

let h: Awaited<ReturnType<typeof startHarness>>;
let admin: { cookie: string };
let member: { cookie: string };
const mocks: MockUpstream[] = [];

beforeAll(async () => {
  h = await startHarness();
  admin = await h.loginAs("admin@example.com", "admin");
  member = await h.loginAs("member@example.com", "member");
}, 30_000);

afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.stop()));
  await h.db.delete(mcpServers);
  await h.upstreams.tick(); // forget the deleted servers
});
afterAll(async () => {
  await h.close();
});

// Most tests use a loopback URL whose port nothing listens on: it is allowlisted (so it passes the
// SSRF guard) and the manager's background connection attempt is refused instantly instead of
// waiting on a real network. PUBLIC_URL (a public IP literal, no DNS needed) is only used on
// servers created disabled, which the manager never contacts.
const LOCAL = "http://127.0.0.1:1/mcp";
const PUBLIC_URL = "http://93.184.216.34/mcp";
const create = (body: unknown, who = admin) => h.call("/api/servers", { body, cookie: who.cookie });
const json = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const rowBySlug = async (slug: string) => (await h.db.select().from(mcpServers).where(eq(mcpServers.slug, slug)))[0];

describe("who may do what", () => {
  it("requires login, lets members read, and reserves changes for admins", async () => {
    expect((await h.call("/api/servers")).status).toBe(401);
    expect((await h.call("/api/servers", { cookie: member.cookie })).status).toBe(200);
    expect((await create({ slug: "shop", url: LOCAL }, member)).status).toBe(403);

    const made = await json(await create({ slug: "shop", url: LOCAL }));
    const id = made.server.id as string;
    expect((await h.call(`/api/servers/${id}`, { method: "PATCH", body: { enabled: false }, cookie: member.cookie })).status).toBe(403);
    expect((await h.call(`/api/servers/${id}`, { method: "DELETE", cookie: member.cookie })).status).toBe(403);
  });
});

describe("credentials never come back out", () => {
  it("stores the credential encrypted and returns only hasCredential", async () => {
    const res = await create({ slug: "shop", url: LOCAL, authType: "bearer", credential: "s3cret-token-value" });
    expect(res.status).toBe(201);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("s3cret-token-value");
    expect(text).not.toMatch(/credential_?enc/i);
    expect(JSON.parse(text).server.hasCredential).toBe(true);

    const row = await rowBySlug("shop");
    expect(row?.credentialEnc).toBeTruthy();
    expect(row?.credentialEnc).not.toContain("s3cret");
    expect(decryptCredential(Buffer.from(h.config.CREDENTIAL_ENC_KEY, "hex"), row?.credentialEnc ?? "")).toBe("s3cret-token-value");

    const listed = JSON.stringify(await (await h.call("/api/servers", { cookie: admin.cookie })).json());
    expect(listed).not.toContain("s3cret");
    expect(listed).not.toMatch(/credential_?enc/i);
  });

  it("last_error is for admins only", async () => {
    await create({ slug: "shop", url: LOCAL, enabled: false }); // disabled: the manager must not touch its row
    await h.db.update(mcpServers).set({ status: "down", lastError: "connect ECONNREFUSED 10.1.2.3:3000" });
    const forAdmin = await json(await h.call("/api/servers", { cookie: admin.cookie }));
    const forMember = await json(await h.call("/api/servers", { cookie: member.cookie }));
    expect(forAdmin.servers[0].lastError).toContain("ECONNREFUSED");
    expect(forMember.servers[0].lastError).toBeNull();
    expect(forMember.servers[0].status).toBe("down"); // the status itself is visible to everyone
  });
});

describe("creating a server", () => {
  it("accepts a public IP address (nothing is contacted: the server is created disabled)", async () => {
    const res = await create({ slug: "public", url: PUBLIC_URL, enabled: false });
    expect(res.status).toBe(201);
  });

  it("applies defaults", async () => {
    const { server } = await json(await create({ slug: "shop", url: LOCAL }));
    expect(server).toMatchObject({ slug: "shop", authType: "none", hasCredential: false, enabled: true, timeoutMs: 15000, status: "unknown" });
  });

  it.each([
    [{ slug: "Bad Slug", url: LOCAL }, /slug/],
    [{ slug: "a__b", url: LOCAL }, /slug/],
    [{ slug: "1shop", url: LOCAL }, /slug/],
    [{ slug: "x".repeat(33), url: LOCAL }, /slug/],
    [{ slug: "shop", url: LOCAL, timeoutMs: 10 }, /timeoutMs/],
    [{ slug: "shop", url: LOCAL, surprise: true }, /./],
    [{ slug: "shop", url: LOCAL, authType: "bearer" }, /credential/],
    [{ slug: "shop", url: LOCAL, authType: "none", credential: "x" }, /credential/],
  ])("rejects invalid input %#", async (body, message) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(message);
    expect(await h.db.select().from(mcpServers)).toHaveLength(0);
  });

  it("refuses URLs the SSRF guard blocks, with a message that says why", async () => {
    const metadata = await create({ slug: "meta", url: "http://169.254.169.254/latest/meta-data/" });
    expect(metadata.status).toBe(400);
    expect((await json(metadata)).error).toMatch(/metadata|link-local/);

    const internal = await create({ slug: "intranet", url: "http://10.0.0.5/mcp" });
    expect(internal.status).toBe(400);
    expect((await json(internal)).error).toContain("UPSTREAM_ALLOWED_HOSTS");

    expect((await create({ slug: "ftp", url: "ftp://example.com/" })).status).toBe(400);
    expect(await h.db.select().from(mcpServers)).toHaveLength(0);
  });

  it("allows an internal host that is on the allowlist", async () => {
    expect((await create({ slug: "local", url: "http://127.0.0.1:9/mcp" })).status).toBe(201);
  });

  it("rejects a duplicate slug with 409", async () => {
    await create({ slug: "shop", url: LOCAL });
    expect((await create({ slug: "shop", url: LOCAL })).status).toBe(409);
  });
});

describe("editing a server", () => {
  const make = async (extra: Record<string, unknown> = {}) =>
    ((await json(await create({ slug: "shop", url: LOCAL, ...extra }))).server.id as string);
  const patch = (id: string, body: unknown, who = admin) => h.call(`/api/servers/${id}`, { method: "PATCH", body, cookie: who.cookie });

  it("toggles enabled and changes the timeout", async () => {
    const id = await make();
    const { server } = await json(await patch(id, { enabled: false, timeoutMs: 5000 }));
    expect(server).toMatchObject({ enabled: false, timeoutMs: 5000 });
  });

  it("keeps the credential when none is sent, replaces it when one is", async () => {
    const id = await make({ authType: "bearer", credential: "first-token" });
    const key = Buffer.from(h.config.CREDENTIAL_ENC_KEY, "hex");

    await patch(id, { timeoutMs: 20000 });
    expect(decryptCredential(key, (await rowBySlug("shop"))?.credentialEnc ?? "")).toBe("first-token");

    await patch(id, { credential: "second-token" });
    expect(decryptCredential(key, (await rowBySlug("shop"))?.credentialEnc ?? "")).toBe("second-token");
  });

  it("switching to none removes the stored credential; switching back needs a new one", async () => {
    const id = await make({ authType: "bearer", credential: "tok" });
    const { server } = await json(await patch(id, { authType: "none" }));
    expect(server.hasCredential).toBe(false);
    expect((await rowBySlug("shop"))?.credentialEnc).toBeNull();
    expect((await patch(id, { authType: "bearer" })).status).toBe(400);
    expect((await patch(id, { authType: "bearer", credential: "new" })).status).toBe(200);
  });

  it("re-checks a new URL, will not rename the slug, and 404s for unknown or malformed ids", async () => {
    const id = await make();
    expect((await patch(id, { url: "http://169.254.169.254/" })).status).toBe(400);
    expect((await patch(id, { slug: "other" })).status).toBe(400);
    expect((await patch("00000000-0000-4000-8000-000000000000", { enabled: false })).status).toBe(404);
    expect((await patch("not-a-uuid", { enabled: false })).status).toBe(404);
    expect((await rowBySlug("shop"))?.url).toBe(LOCAL);
  });
});

describe("deleting a server", () => {
  it("removes it and its tool policies", async () => {
    const { server } = await json(await create({ slug: "shop", url: LOCAL }));
    await h.db.insert(toolPolicies).values({ serverId: server.id, toolName: "x", enabled: false });
    expect((await h.call(`/api/servers/${server.id}`, { method: "DELETE", cookie: admin.cookie })).status).toBe(204);
    expect((await json(await h.call("/api/servers", { cookie: admin.cookie }))).servers).toHaveLength(0);
    expect(await h.db.select().from(toolPolicies)).toHaveLength(0);
    expect((await h.call(`/api/servers/${server.id}`, { method: "DELETE", cookie: admin.cookie })).status).toBe(404);
  });
});

describe("with a live upstream", () => {
  it("shows status and tool count, lists tools grouped by server, hides policy-disabled tools, and drops a disabled server", async () => {
    const mock = new MockUpstream([{ name: "list_products", description: "Lists products" }, { name: "delete_everything" }]);
    await mock.start();
    mocks.push(mock);
    const { server } = await json(await create({ slug: "shop", url: mock.url, timeoutMs: 1000 }));
    await h.upstreams.tick();

    const servers = await json(await h.call("/api/servers", { cookie: member.cookie }));
    expect(servers.servers[0]).toMatchObject({ slug: "shop", status: "up", toolCount: 2 });

    await h.db.insert(toolPolicies).values({ serverId: server.id, toolName: "delete_everything", enabled: false });
    const tools = await json(await h.call("/api/tools", { cookie: member.cookie }));
    expect(tools.servers).toEqual([
      { slug: "shop", status: "up", tools: [{ name: "shop__list_products", original: "list_products", description: "[shop] Lists products" }] },
    ]);

    await h.call(`/api/servers/${server.id}`, { method: "PATCH", body: { enabled: false }, cookie: admin.cookie });
    await h.upstreams.tick();
    expect((await json(await h.call("/api/tools", { cookie: member.cookie }))).servers).toEqual([]);
    expect((await json(await h.call("/api/servers", { cookie: member.cookie }))).servers[0].toolCount).toBe(0);
  });

  it("lists a down server with no tools, so the drawer can say why", async () => {
    await create({ slug: "gone", url: "http://127.0.0.1:1/mcp", timeoutMs: 1000 });
    await h.upstreams.tick();
    await h.upstreams.tick();
    const tools = await json(await h.call("/api/tools", { cookie: member.cookie }));
    expect(tools.servers).toEqual([{ slug: "gone", status: "down", tools: [] }]);
  });
});
