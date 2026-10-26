import express, { type ErrorRequestHandler, type Express } from "express";
import { sql } from "drizzle-orm";
import { requireSession } from "./auth/guards.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { HttpError } from "./http.js";
import type { Logger } from "./logger.js";
import { apiKeyRoutes } from "./routes/apiKeys.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import type { RouteDeps } from "./routes/deps.js";
import { inviteRoutes } from "./routes/invites.js";
import { mcpRoutes } from "./routes/mcp.js";
import { serverRoutes, toolRoutes } from "./routes/servers.js";
import { userRoutes } from "./routes/users.js";
import type { UpstreamManager } from "./upstream/manager.js";

export interface AppOptions {
  db: Db;
  config: Config;
  logger: Logger;
  /** The gateway's view of the upstream MCP servers; POST /mcp serves its tools. */
  upstreams: UpstreamManager;
  /** Becomes true on SIGTERM so /readyz fails and the pod is taken out of rotation. */
  isShuttingDown?: () => boolean;
}

export function createApp(opts: AppOptions): Express {
  const { db, config, logger, upstreams } = opts;
  const app = express();
  app.disable("x-powered-by");

  // Probes carry no cookie (the kubelet cannot send one), so they sit outside /api and its guards.
  // /healthz = the process is alive: it must NOT touch the database, or a database outage would
  // make Kubernetes restart healthy pods. /readyz = it can serve traffic, which for the gateway
  // requires the database, so a pod that lost it leaves the Service until it is back.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", async (_req, res) => {
    if (opts.isShuttingDown?.()) {
      res.status(503).json({ status: "shutting_down" });
      return;
    }
    try {
      await db.execute(sql`select 1`);
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "database_unavailable" });
    }
  });

  // The MCP endpoint authenticates with API keys (not cookies) and has its own body parsing and
  // error format, so it is mounted before the /api middleware below and shares none of it.
  app.use("/mcp", mcpRoutes({ db, logger, upstreams }));

  const deps: RouteDeps = { db, config, logger, upstreams, requireLogin: requireSession(db, config.SESSION_SECRET) };

  // The chat endpoint streams its answer and accepts bigger bodies, so it parses its own JSON and is
  // mounted before the general /api parser below (which would reject anything over 100 kb first).
  app.use("/api/chat", chatRoutes(deps));

  // express.json only parses bodies sent as application/json. A cross-site <form> cannot send that
  // content type, so together with SameSite=Lax cookies it is a second barrier against CSRF.
  app.use("/api", express.json({ limit: "100kb" }));

  app.use("/api/auth", authRoutes(deps));
  app.use("/api/invites", inviteRoutes(deps));
  app.use("/api/api-keys", apiKeyRoutes(deps));
  app.use("/api/servers", serverRoutes(deps));
  app.use("/api/tools", toolRoutes(deps));
  app.use("/api/users", userRoutes(deps));
  app.use("/api/audit", auditRoutes(deps));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // The single place where errors become HTTP responses. Express 5 forwards errors thrown (or
  // rejected) inside async handlers here, so handlers need no try/catch.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express only treats a function with 4 parameters as an error handler
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    // Malformed JSON and oversized bodies are raised by the body parser with a 4xx status.
    if (typeof err?.status === "number" && err.status >= 400 && err.status < 500) {
      res.status(err.status).json({ error: "Invalid request body" });
      return;
    }
    // A bug or an outage: log the details here, tell the client nothing about the internals.
    logger.error({ err }, "unhandled error");
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(onError);

  return app;
}
