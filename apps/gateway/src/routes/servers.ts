import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { currentUser, requireRole } from "../auth/guards.js";
import { authTypeEnum, mcpServers } from "../db/schema.js";
import { HttpError, parse } from "../http.js";
import { loadDisabledTools, policyKey } from "../mcp/policies.js";
import { createServer, deleteServer, toDto, updateServer } from "../servers/service.js";
import { SLUG_PATTERN } from "../upstream/namespacing.js";
import type { RouteDeps } from "./deps.js";

const url = z.string().trim().min(1).max(2000);
const credential = z.string().min(1).max(4096);
const timeoutMs = z.number().int().min(1000).max(120_000);

const createBody = z
  .object({
    slug: z.string().regex(SLUG_PATTERN, "must start with a letter and use only lower-case letters, digits and single hyphens, at most 32 characters"),
    url,
    authType: z.enum(authTypeEnum.enumValues).default("none"),
    credential: credential.optional(),
    timeoutMs: timeoutMs.default(15_000),
    enabled: z.boolean().default(true),
  })
  .strict();

// The slug is NOT editable: it is part of every published tool name (<slug>__<tool>), so renaming
// it would silently break every client that already uses those names. Delete and re-create instead.
const patchBody = z.object({ url, authType: z.enum(authTypeEnum.enumValues), credential, timeoutMs, enabled: z.boolean() }).partial().strict();

const idParam = z.string().uuid();

export function serverRoutes({ db, config, logger, requireLogin, upstreams }: RouteDeps): Router {
  const router = Router();
  router.use(requireLogin);

  // After any change, ask the manager to re-read the table now instead of waiting for its 10 s tick.
  const refreshSoon = () => {
    upstreams.tick().catch((err: unknown) => logger.error({ err }, "refresh after server change failed"));
  };

  // Everyone logged in may SEE the servers and their status; only admins may change them.
  router.get("/", async (_req, res) => {
    const isAdmin = currentUser(res).role === "admin";
    const rows = await db.select().from(mcpServers).orderBy(mcpServers.slug);
    const counts = new Map<string, number>();
    for (const entry of upstreams.listEntries()) counts.set(entry.slug, (counts.get(entry.slug) ?? 0) + 1);
    res.json({ servers: rows.map((row) => toDto(row, counts.get(row.slug) ?? 0, isAdmin)) });
  });

  router.post("/", requireRole("admin"), async (req, res) => {
    const row = await createServer(db, config, parse(createBody, req.body));
    refreshSoon();
    res.status(201).json({ server: toDto(row, 0, true) });
  });

  router.patch("/:id", requireRole("admin"), async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, "Server not found");
    const row = await updateServer(db, config, id.data, parse(patchBody, req.body));
    refreshSoon();
    res.json({ server: toDto(row, 0, true) });
  });

  router.delete("/:id", requireRole("admin"), async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, "Server not found");
    await deleteServer(db, id.data);
    refreshSoon();
    res.status(204).end();
  });

  return router;
}

// GET /api/tools: what the "tools" drawer shows, grouped by server. Same visibility rules as MCP
// tools/list (healthy servers only, minus tools an admin disabled), but every enabled server is
// listed, with an empty tool list and its status when it is down, so the drawer can say why.
export function toolRoutes({ db, requireLogin, upstreams }: RouteDeps): Router {
  const router = Router();
  router.use(requireLogin);

  router.get("/", async (_req, res) => {
    const [servers, disabled] = await Promise.all([
      db.select().from(mcpServers).where(eq(mcpServers.enabled, true)).orderBy(mcpServers.slug),
      loadDisabledTools(db),
    ]);
    const entries = upstreams.listEntries().filter((e) => !disabled.has(policyKey(e.serverId, e.original)));
    res.json({
      servers: servers.map((s) => ({
        slug: s.slug,
        status: s.status,
        tools: entries
          .filter((e) => e.slug === s.slug)
          .map((e) => ({ name: e.tool.name, original: e.original, description: e.tool.description ?? "" })),
      })),
    });
  });

  return router;
}
