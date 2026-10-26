import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticateApiKey, createApiKey } from "./auth/apiKeys.js";
import { invites } from "./db/schema.js";
import { startHarness } from "./test/appHarness.js";

let h: Awaited<ReturnType<typeof startHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let member: Awaited<ReturnType<typeof h.loginAs>>;

beforeAll(async () => {
  h = await startHarness();
  admin = await h.loginAs("admin@example.com", "admin");
  member = await h.loginAs("member@example.com", "member");
}, 30_000);
afterAll(async () => {
  await h.close();
});

const json = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("GET /api/users", () => {
  it("is admin only and counts each user's ACTIVE keys", async () => {
    expect((await h.call("/api/users")).status).toBe(401);
    expect((await h.call("/api/users", { cookie: member.cookie })).status).toBe(403);

    await createApiKey(h.db, member.user.id, "laptop");
    const revoked = await createApiKey(h.db, member.user.id, "old");
    await h.call(`/api/api-keys/${revoked.apiKey.id}/revoke`, { method: "POST", cookie: admin.cookie });

    const { users } = await json(await h.call("/api/users", { cookie: admin.cookie }));
    const byEmail = Object.fromEntries(users.map((u: { email: string }) => [u.email, u]));
    expect(byEmail["member@example.com"]).toMatchObject({ role: "member", activeKeys: 1 });
    expect(byEmail["admin@example.com"]).toMatchObject({ role: "admin", activeKeys: 0 });
    expect(JSON.stringify(users)).not.toContain("passwordHash");
  });
});

describe("changing a role", () => {
  it("promotes and demotes another user, but never yourself", async () => {
    const other = await h.loginAs("other@example.com", "member");
    const patch = (id: string, role: unknown) => h.call(`/api/users/${id}`, { method: "PATCH", body: { role }, cookie: admin.cookie });

    expect((await patch(other.user.id, "admin")).status).toBe(200);
    expect((await json(await h.call("/api/users", { cookie: admin.cookie }))).users.find((u: { id: string }) => u.id === other.user.id).role).toBe("admin");
    expect((await patch(other.user.id, "member")).status).toBe(200);

    const self = await patch(admin.user.id, "member");
    expect(self.status).toBe(400);
    expect((await json(self)).error).toMatch(/own role/);

    expect((await patch(other.user.id, "superuser")).status).toBe(400);
    expect((await patch("00000000-0000-4000-8000-000000000000", "member")).status).toBe(404);
  });

  it("a member cannot change roles", async () => {
    const res = await h.call(`/api/users/${member.user.id}`, { method: "PATCH", body: { role: "admin" }, cookie: member.cookie });
    expect(res.status).toBe(403);
  });
});

describe("another user's keys", () => {
  it("an admin sees a member's keys (never the key itself) and can revoke one, which stops it working", async () => {
    const owner = await h.loginAs("keys@example.com", "member");
    const { apiKey, key } = await createApiKey(h.db, owner.user.id, "ci");

    expect((await h.call(`/api/users/${owner.user.id}/api-keys`, { cookie: member.cookie })).status).toBe(403);
    const res = await h.call(`/api/users/${owner.user.id}/api-keys`, { cookie: admin.cookie });
    const text = JSON.stringify(await res.json());
    expect(text).toContain(apiKey.keyPrefix);
    expect(text).not.toContain(key);
    expect(text).not.toContain("keyHash");

    expect(await authenticateApiKey(h.db, key)).toBeDefined();
    expect((await h.call(`/api/api-keys/${apiKey.id}/revoke`, { method: "POST", cookie: admin.cookie })).status).toBe(204);
    expect(await authenticateApiKey(h.db, key)).toBeUndefined();

    expect((await h.call("/api/users/00000000-0000-4000-8000-000000000000/api-keys", { cookie: admin.cookie })).status).toBe(404);
  });
});

describe("GET /api/invites", () => {
  it("is admin only and reports pending, accepted and expired invites, without any link", async () => {
    expect((await h.call("/api/invites", { cookie: member.cookie })).status).toBe(403);

    const mk = async (email: string) => {
      const res = await json(await h.call("/api/invites", { body: { email }, cookie: admin.cookie }));
      return { url: res.url as string, token: (res.url as string).split("/invite/")[1] ?? "" };
    };
    await mk("pending@example.com");
    const accepted = await mk("accepted@example.com");
    await h.call(`/api/invites/${accepted.token}/accept`, { body: { password: "a-brand-new-password" } });
    await mk("expired@example.com");
    await h.db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.email, "expired@example.com"));

    const { invites: list } = await json(await h.call("/api/invites", { cookie: admin.cookie }));
    const status = Object.fromEntries(list.map((i: { email: string; status: string }) => [i.email, i.status]));
    expect(status).toMatchObject({ "pending@example.com": "pending", "accepted@example.com": "accepted", "expired@example.com": "expired" });
    expect(JSON.stringify(list)).not.toMatch(/token|url/i);
  });
});
