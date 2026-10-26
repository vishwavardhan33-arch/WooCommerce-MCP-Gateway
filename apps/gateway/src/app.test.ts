import { eq } from "drizzle-orm";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { authenticateApiKey } from "./auth/apiKeys.js";
import { bootstrapAdmin } from "./auth/bootstrap.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { invites, sessions, users } from "./db/schema.js";
import { createTestDb, seedUser, silentLogger, testConfig } from "./test/helpers.js";
import { UpstreamManager } from "./upstream/manager.js";

// These tests drive the real app over real HTTP against an in-memory Postgres.
const PASSWORD = "correct-horse-battery";
let db: Db;
let close: () => Promise<void>;
let config: Config;
let server: Server;
let base: string;
let shuttingDown = false;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  config = testConfig();
  await bootstrapAdmin(db, { email: config.ADMIN_BOOTSTRAP_EMAIL, password: config.ADMIN_BOOTSTRAP_PASSWORD }, silentLogger);
  // These tests are about accounts, so the manager is never started and has no servers.
  const upstreams = new UpstreamManager({ db, logger: silentLogger, credentialKey: Buffer.alloc(32), allowedHosts: [] });
  const app = createApp({ db, config, logger: silentLogger, upstreams, isShuttingDown: () => shuttingDown });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await close();
});

interface CallOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
}
const call = (path: string, { method, body, cookie }: CallOptions = {}) =>
  fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Logs in and returns the "session=<token>" pair to send back as the Cookie header.
async function loginCookie(email: string, password: string): Promise<string> {
  const res = await call("/api/auth/login", { body: { email, password } });
  expect(res.status).toBe(200);
  return (res.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
}
const adminCookie = () => loginCookie(config.ADMIN_BOOTSTRAP_EMAIL, config.ADMIN_BOOTSTRAP_PASSWORD);

describe("probes", () => {
  it("/healthz and /readyz need no login, and /readyz checks the database", async () => {
    expect((await call("/healthz")).status).toBe(200);
    expect((await call("/readyz")).status).toBe(200);
  });

  it("/readyz fails while shutting down, /healthz stays up", async () => {
    shuttingDown = true;
    try {
      expect((await call("/readyz")).status).toBe(503);
      expect((await call("/healthz")).status).toBe(200);
    } finally {
      shuttingDown = false;
    }
  });
});

describe("bootstrap admin", () => {
  it("creates one admin, and running it again changes nothing", async () => {
    await bootstrapAdmin(db, { email: "someone-else@example.com", password: "another-long-password" }, silentLogger);
    const admins = await db.select().from(users).where(eq(users.role, "admin"));
    expect(admins).toHaveLength(1);
    expect(admins[0]?.email).toBe(config.ADMIN_BOOTSTRAP_EMAIL);
    await adminCookie(); // the original password still works
  });
});

describe("login and sessions", () => {
  it("gives the same 401 for a wrong password and an unknown email", async () => {
    const wrong = await call("/api/auth/login", { body: { email: config.ADMIN_BOOTSTRAP_EMAIL, password: "wrong-password-1" } });
    const unknown = await call("/api/auth/login", { body: { email: "nobody@example.com", password: "wrong-password-1" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(wrong.headers.getSetCookie()).toHaveLength(0);
  });

  it("sets an HttpOnly, SameSite=Lax cookie that never contains the token in the database", async () => {
    const res = await call("/api/auth/login", { body: { email: config.ADMIN_BOOTSTRAP_EMAIL, password: config.ADMIN_BOOTSTRAP_PASSWORD } });
    const setCookie = res.headers.getSetCookie()[0] ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const token = (setCookie.split(";")[0] ?? "").split("=")[1] ?? "";
    const stored = await db.select().from(sessions).where(eq(sessions.tokenHash, token));
    expect(stored).toHaveLength(0); // only a keyed hash is stored, never the token itself
  });

  it("/me works with the cookie, fails without it, and fails again after logout", async () => {
    expect((await call("/api/auth/me")).status).toBe(401);
    const cookie = await adminCookie();
    const me = await call("/api/auth/me", { cookie });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { role: string } }).user.role).toBe("admin");

    expect((await call("/api/auth/logout", { method: "POST", cookie })).status).toBe(204);
    expect((await call("/api/auth/me", { cookie })).status).toBe(401); // the old cookie is dead server-side
  });

  it("rejects an expired session", async () => {
    const cookie = await adminCookie();
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await call("/api/auth/me", { cookie })).status).toBe(401);
  });
});

describe("invite flow", () => {
  it("only an admin can create an invite", async () => {
    await seedUser(db, "member1@example.com", "member", PASSWORD);
    const memberCookie = await loginCookie("member1@example.com", PASSWORD);
    const body = { email: "new1@example.com" };
    expect((await call("/api/invites", { body })).status).toBe(401);
    expect((await call("/api/invites", { body, cookie: memberCookie })).status).toBe(403);
    expect((await call("/api/invites", { body, cookie: await adminCookie() })).status).toBe(201);
  });

  it("the link works exactly once, then the new user can log in", async () => {
    const created = await call("/api/invites", { body: { email: "New2@Example.com" }, cookie: await adminCookie() });
    const { url } = (await created.json()) as { url: string };
    expect(url.startsWith("http://app.test/invite/")).toBe(true);
    const token = url.split("/invite/")[1] ?? "";

    // The raw token is not stored, only its hash.
    expect((await db.select().from(invites)).some((i) => i.tokenHash === token)).toBe(false);

    const weak = await call(`/api/invites/${token}/accept`, { body: { password: "short" } });
    expect(weak.status).toBe(400);

    const ok = await call(`/api/invites/${token}/accept`, { body: { password: "a-brand-new-password" } });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { user: { email: string; role: string } }).user).toMatchObject({
      email: "new2@example.com",
      role: "member",
    });

    const again = await call(`/api/invites/${token}/accept`, { body: { password: "a-brand-new-password" } });
    expect(again.status).toBe(400);

    await loginCookie("new2@example.com", "a-brand-new-password");
  });

  it("rejects an unknown token and an expired invite", async () => {
    expect((await call("/api/invites/not-a-real-token/accept", { body: { password: "a-brand-new-password" } })).status).toBe(400);

    const created = await call("/api/invites", { body: { email: "late@example.com" }, cookie: await adminCookie() });
    const token = (((await created.json()) as { url: string }).url.split("/invite/")[1]) ?? "";
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.email, "late@example.com"));
    expect((await call(`/api/invites/${token}/accept`, { body: { password: "a-brand-new-password" } })).status).toBe(400);
  });

  it("refuses to invite an email that already has an account", async () => {
    const res = await call("/api/invites", { body: { email: config.ADMIN_BOOTSTRAP_EMAIL }, cookie: await adminCookie() });
    expect(res.status).toBe(409);
  });
});

describe("API keys over HTTP", () => {
  it("create shows the key once, list never does, revoke ends it", async () => {
    await seedUser(db, "keyowner@example.com", "member", PASSWORD);
    const cookie = await loginCookie("keyowner@example.com", PASSWORD);

    expect((await call("/api/api-keys")).status).toBe(401);

    const created = await call("/api/api-keys", { body: { name: "my laptop" }, cookie });
    expect(created.status).toBe(201);
    const { apiKey, key } = (await created.json()) as { apiKey: { id: string; keyPrefix: string }; key: string };
    expect(key.startsWith("mcp_")).toBe(true);
    expect(key.startsWith(apiKey.keyPrefix)).toBe(true);
    expect(await authenticateApiKey(db, key)).toBeDefined();

    const listText = await (await call("/api/api-keys", { cookie })).text();
    expect(listText).toContain(apiKey.keyPrefix);
    expect(listText).not.toContain(key);

    expect((await call(`/api/api-keys/${apiKey.id}/revoke`, { method: "POST", cookie })).status).toBe(204);
    expect(await authenticateApiKey(db, key)).toBeUndefined();
  });

  it("answers 404 for a malformed key id and 400 for a missing name", async () => {
    const cookie = await adminCookie();
    expect((await call("/api/api-keys/not-a-uuid/revoke", { method: "POST", cookie })).status).toBe(404);
    expect((await call("/api/api-keys", { body: {}, cookie })).status).toBe(400);
  });
});

describe("error handling", () => {
  it("answers malformed JSON with 400 and unknown /api paths with 404", async () => {
    const bad = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
    expect(bad.status).toBe(400);
    expect((await call("/api/nope")).status).toBe(404);
  });
});
