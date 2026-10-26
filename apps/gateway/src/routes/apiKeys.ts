import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../auth/guards.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../auth/apiKeys.js";
import { HttpError, parse } from "../http.js";
import type { RouteDeps } from "./deps.js";

const createBody = z.object({ name: z.string().trim().min(1).max(100) });

export function apiKeyRoutes({ db, requireLogin }: RouteDeps): Router {
  const router = Router();
  // Any logged-in user (member or admin) manages their own keys, so the guard goes on the whole router.
  router.use(requireLogin);

  router.post("/", async (req, res) => {
    const { name } = parse(createBody, req.body);
    const { apiKey, key } = await createApiKey(db, currentUser(res).id, name);
    // `key` is in this response and nowhere else, ever. If the user loses it, they create a new one.
    res.status(201).json({ apiKey, key });
  });

  router.get("/", async (_req, res) => {
    res.json({ apiKeys: await listApiKeys(db, currentUser(res).id) });
  });

  // POST .../revoke, not DELETE: the row is kept (with revoked_at set), so it is not a deletion.
  router.post("/:id/revoke", async (req, res) => {
    // A malformed id would make Postgres throw "invalid uuid"; answer 404 like any other unknown key.
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, "API key not found");
    await revokeApiKey(db, currentUser(res), id.data);
    res.status(204).end();
  });

  return router;
}
