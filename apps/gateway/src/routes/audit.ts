import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../auth/guards.js";
import { apiKeys, auditLog, users } from "../db/schema.js";
import { parse } from "../http.js";
import type { RouteDeps } from "./deps.js";

// Everything the dashboard shows about audit_log. Admins see every row; members see only THEIR OWN
// (their user id is added to every query below, whatever filters they send).

const listQuery = z.object({
  server: z.string().max(64).optional(),
  tool: z.string().max(200).optional(),
  status: z.enum(["ok", "error", "denied"]).optional(),
  source: z.enum(["mcp", "chat"]).optional(),
  userId: z.string().uuid().optional(), // admins only; ignored for members
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const summaryQuery = z.object({ hours: z.coerce.number().int().min(1).max(720).default(24) });

// audit_log.detail is JSON; ->> reads one field of it as text.
const field = (name: string) => sql`${auditLog.detail}->>${name}`;

export function auditRoutes({ db, requireLogin }: RouteDeps): Router {
  const router = Router();
  router.use(requireLogin);

  router.get("/", async (req, res) => {
    const me = currentUser(res);
    const q = parse(listQuery, req.query);

    const where: SQL[] = [];
    if (me.role !== "admin") where.push(eq(auditLog.actorUserId, me.id));
    else if (q.userId) where.push(eq(auditLog.actorUserId, q.userId));
    if (q.server) where.push(sql`${field("server")} = ${q.server}`);
    if (q.tool) where.push(sql`${field("tool")} = ${q.tool}`);
    if (q.status) where.push(sql`${field("status")} = ${q.status}`);
    if (q.source) where.push(sql`${field("source")} = ${q.source}`);

    const rows = await db
      .select({
        id: auditLog.id,
        createdAt: auditLog.createdAt,
        userEmail: users.email,
        keyName: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        action: auditLog.action,
        target: auditLog.target,
        ok: auditLog.ok,
        detail: auditLog.detail,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.actorUserId, users.id))
      .leftJoin(apiKeys, eq(auditLog.apiKeyId, apiKeys.id))
      .where(and(...where))
      .orderBy(desc(auditLog.createdAt))
      .limit(q.limit)
      .offset(q.offset);
    res.json({ entries: rows });
  });

  // Per-server health of the calls in the last N hours: volume, failures and latency.
  router.get("/summary", async (req, res) => {
    const me = currentUser(res);
    const { hours } = parse(summaryQuery, req.query);
    const own = me.role === "admin" ? sql`true` : sql`${auditLog.actorUserId} = ${me.id}`;

    const result = await db.execute(sql`
      select
        ${field("server")} as server,
        count(*)::int as calls,
        (count(*) filter (where ${field("status")} = 'error'))::int as errors,
        (count(*) filter (where ${field("status")} = 'denied'))::int as denied,
        round(avg((${field("durationMs")})::numeric))::int as avg_ms,
        round(percentile_cont(0.95) within group (order by (${field("durationMs")})::numeric))::int as p95_ms
      from ${auditLog}
      where ${auditLog.action} = 'tool.call'
        and ${auditLog.createdAt} > now() - make_interval(hours => ${hours})
        and ${field("server")} is not null
        and ${own}
      group by 1
      order by calls desc
    `);
    const rows = result.rows as { server: string; calls: number; errors: number; denied: number; avg_ms: number; p95_ms: number }[];
    res.json({
      hours,
      servers: rows.map((r) => ({ server: r.server, calls: r.calls, errors: r.errors, denied: r.denied, avgMs: r.avg_ms, p95Ms: r.p95_ms })),
    });
  });

  return router;
}
