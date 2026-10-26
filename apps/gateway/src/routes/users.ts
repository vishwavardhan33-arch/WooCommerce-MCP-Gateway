import { eq, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { listApiKeys } from "../auth/apiKeys.js";
import { currentUser, requireRole } from "../auth/guards.js";
import { apiKeys, roleEnum, users } from "../db/schema.js";
import { HttpError, parse } from "../http.js";
import type { RouteDeps } from "./deps.js";

const idParam = z.string().uuid();
const roleBody = z.object({ role: z.enum(roleEnum.enumValues) }).strict();

// The Team page's data. Everything here is admin only.
export function userRoutes({ db, requireLogin }: RouteDeps): Router {
  const router = Router();
  router.use(requireLogin, requireRole("admin"));

  const userId = (raw: unknown): string => {
    const id = idParam.safeParse(raw);
    if (!id.success) throw new HttpError(404, "User not found");
    return id.data;
  };

  router.get("/", async (_req, res) => {
    const rows = await db
      .select({ id: users.id, email: users.email, role: users.role, createdAt: users.createdAt })
      .from(users)
      .orderBy(users.email);
    // Active (not revoked) keys per user, in one grouped query instead of one query per user.
    const counts = await db
      .select({ userId: apiKeys.userId, n: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(isNull(apiKeys.revokedAt))
      .groupBy(apiKeys.userId);
    const activeKeys = new Map(counts.map((c) => [c.userId, c.n]));
    res.json({ users: rows.map((u) => ({ ...u, activeKeys: activeKeys.get(u.id) ?? 0 })) });
  });

  // An admin may not change their OWN role. That single rule guarantees at least one admin always
  // remains (the one making the change), so the team can never lock itself out.
  router.patch("/:id", async (req, res) => {
    const id = userId(req.params.id);
    const { role } = parse(roleBody, req.body);
    if (id === currentUser(res).id) throw new HttpError(400, "You cannot change your own role");
    const [updated] = await db
      .update(users)
      .set({ role })
      .where(eq(users.id, id))
      .returning({ id: users.id, email: users.email, role: users.role });
    if (!updated) throw new HttpError(404, "User not found");
    res.json({ user: updated });
  });

  // Another user's keys (prefix, dates, revoked state; never the key). Revoking goes through the
  // existing POST /api/api-keys/:id/revoke, which already lets admins revoke anyone's key.
  router.get("/:id/api-keys", async (req, res) => {
    const id = userId(req.params.id);
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
    if (!exists) throw new HttpError(404, "User not found");
    res.json({ apiKeys: await listApiKeys(db, id) });
  });

  return router;
}
