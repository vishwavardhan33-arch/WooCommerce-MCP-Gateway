import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "../db/schema.js";
import { readCookie, requireRole } from "./guards.js";

// requireRole only reads res.locals.user, so it is tested on its own: a stand-in "login" step
// (the x-test-role header) puts a user there, the way requireSession does in the real app.
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use((req, res, next) => {
    const role = req.header("x-test-role");
    if (role) res.locals.user = { id: "u1", email: "u1@example.com", role: role as Role };
    next();
  });
  app.get("/admin-only", requireRole("admin"), (_req, res) => res.json({ ok: true }));
  app.get("/any-role", requireRole("admin", "member"), (_req, res) => res.json({ ok: true }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = (path: string, role?: string) => fetch(`${base}${path}`, { headers: role ? { "x-test-role": role } : {} });

describe("requireRole", () => {
  it("answers 401 when nobody is logged in", async () => {
    expect((await get("/admin-only")).status).toBe(401);
  });

  it("answers 403 when the role is not allowed, and says which role is needed", async () => {
    const res = await get("/admin-only", "member");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("admin");
  });

  it("lets an allowed role through", async () => {
    expect((await get("/admin-only", "admin")).status).toBe(200);
  });

  it("accepts any role in the list", async () => {
    expect((await get("/any-role", "member")).status).toBe(200);
    expect((await get("/any-role", "admin")).status).toBe(200);
  });

  it("does not treat admin as 'member plus': each route lists exactly what it allows", async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.locals.user = { id: "u1", email: "u1@example.com", role: "admin" };
      next();
    });
    app.get("/members-only", requireRole("member"), (_req, res) => res.json({ ok: true }));
    const s = await new Promise<Server>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
    });
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/members-only`;
      expect((await fetch(url)).status).toBe(403);
    } finally {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});

describe("readCookie", () => {
  it("finds the named cookie among several", () => {
    expect(readCookie("theme=dark; session=abc123; lang=en", "session")).toBe("abc123");
  });
  it("returns undefined when absent or when there is no header", () => {
    expect(readCookie("theme=dark", "session")).toBeUndefined();
    expect(readCookie(undefined, "session")).toBeUndefined();
  });
  it("does not match a cookie whose name merely ends with the wanted name", () => {
    expect(readCookie("not-session=evil", "session")).toBeUndefined();
  });
});
