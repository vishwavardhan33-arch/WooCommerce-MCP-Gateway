import { desc } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { currentUser, requireRole } from "../auth/guards.js";
import { acceptInvite, createInvite } from "../auth/invites.js";
import { invites, roleEnum } from "../db/schema.js";
import { parse } from "../http.js";
import { emailSchema, passwordSchema } from "../validation.js";
import type { RouteDeps } from "./deps.js";

const createBody = z.object({ email: emailSchema, role: z.enum(roleEnum.enumValues).default("member") });
const acceptBody = z.object({ password: passwordSchema });

export function inviteRoutes({ db, config, requireLogin }: RouteDeps): Router {
  const router = Router();

  // Admin only. The link is in this response and nowhere else: it is not stored and cannot be looked up later.
  router.post("/", requireLogin, requireRole("admin"), async (req, res) => {
    const input = parse(createBody, req.body);
    const { invite, token } = await createInvite(db, currentUser(res), input, config.INVITE_TTL_HOURS);
    const baseUrl = config.PUBLIC_BASE_URL.replace(/\/+$/, "");
    res.status(201).json({ invite, url: `${baseUrl}/invite/${token}` });
  });

  // Admin only: who was invited and what became of it. The link itself is NOT here (only its hash is stored).
  router.get("/", requireLogin, requireRole("admin"), async (_req, res) => {
    const rows = await db
      .select({ id: invites.id, email: invites.email, role: invites.role, expiresAt: invites.expiresAt, usedAt: invites.usedAt, createdAt: invites.createdAt })
      .from(invites)
      .orderBy(desc(invites.createdAt))
      .limit(100);
    const now = Date.now();
    res.json({
      invites: rows.map((r) => ({
        ...r,
        status: r.usedAt ? "accepted" : r.expiresAt.getTime() <= now ? "expired" : "pending",
      })),
    });
  });

  // PUBLIC on purpose: the person has no account yet. The secret token in the URL is the credential.
  router.post("/:token/accept", async (req, res) => {
    const { password } = parse(acceptBody, req.body);
    const user = await acceptInvite(db, req.params.token, password);
    res.status(201).json({ user });
  });

  return router;
}
