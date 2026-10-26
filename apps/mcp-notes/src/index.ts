import { createApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { NotesStore, openDatabase } from "./notes/store.js";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  // No configured logger yet: print the problem (variable names only) and stop.
  console.error(JSON.stringify({ level: "fatal", msg: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}

const logger = createLogger(config.LOG_LEVEL);

// If the volume is missing or read-only this throws, and the process exits: Kubernetes shows the
// crash and restarts it, which is clearer than serving requests that can only fail.
let db: ReturnType<typeof openDatabase>;
try {
  db = openDatabase(config.NOTES_DB_PATH);
} catch (err) {
  logger.fatal({ err, path: config.NOTES_DB_PATH }, "could not open the notes database");
  process.exit(1);
}
const store = new NotesStore(db);

let shuttingDown = false;
const app = createApp({
  authToken: config.MCP_AUTH_TOKEN,
  ctx: { store, logger, now: () => new Date() },
  isShuttingDown: () => shuttingDown,
});

const httpServer = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "mcp-notes listening");
});

// Graceful shutdown: Kubernetes sends SIGTERM, then SIGKILL after terminationGracePeriodSeconds (30 s).
// Fail /readyz first, stop accepting connections, let in-flight requests finish, close the database
// (which also folds the WAL file back into the main file), then exit.
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  httpServer.close((err) => {
    db.close();
    process.exit(err ? 1 : 0);
  });
  // Safety net: leave before the kubelet kills us if some request never finishes.
  setTimeout(() => {
    logger.error("forced exit: requests still running after 10 s");
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
