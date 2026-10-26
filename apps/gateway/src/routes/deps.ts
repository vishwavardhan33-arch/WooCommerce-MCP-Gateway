import type { RequestHandler } from "express";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { UpstreamManager } from "../upstream/manager.js";

// Everything a route needs, passed in explicitly (no globals), which is also what lets the tests
// run the whole app against an in-memory database.
export interface RouteDeps {
  db: Db;
  config: Config;
  logger: Logger;
  upstreams: UpstreamManager;
  /** Guard 1, built once in app.ts: rejects requests without a valid session. */
  requireLogin: RequestHandler;
}
