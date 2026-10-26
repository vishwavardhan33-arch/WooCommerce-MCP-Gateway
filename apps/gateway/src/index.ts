import { createApp } from "./app.js";
import { bootstrapAdmin } from "./auth/bootstrap.js";
import { loadConfig, type Config } from "./config.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createLogger } from "./logger.js";
import { UpstreamManager } from "./upstream/manager.js";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  // No configured logger yet: print the problem (variable names only) and stop.
  console.error(JSON.stringify({ level: "fatal", msg: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}

const logger = createLogger(config.LOG_LEVEL);
const { db, pool } = createDb(config.DATABASE_URL);
// Without a listener, an error on an idle pooled connection (say, Postgres restarting) would crash the process.
pool.on("error", (err) => logger.error({ err }, "idle postgres connection error"));

const upstreams = new UpstreamManager({
  db,
  logger,
  credentialKey: Buffer.from(config.CREDENTIAL_ENC_KEY, "hex"),
  allowedHosts: config.UPSTREAM_ALLOWED_HOSTS,
});

// Schema first, then the first admin, then the upstream health loop (which reads mcp_servers). If Postgres is not reachable yet we exit and let Kubernetes
// restart us, which is simpler and more honest than writing our own retry loop.
try {
  await runMigrations(db);
  await bootstrapAdmin(db, { email: config.ADMIN_BOOTSTRAP_EMAIL, password: config.ADMIN_BOOTSTRAP_PASSWORD }, logger);
  await upstreams.start();
} catch (err) {
  logger.fatal({ err }, "startup failed");
  process.exit(1);
}

let shuttingDown = false;
const app = createApp({ db, config, logger, upstreams, isShuttingDown: () => shuttingDown });

const httpServer = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "gateway listening");
});

// Graceful shutdown: Kubernetes sends SIGTERM, then SIGKILL after terminationGracePeriodSeconds (30 s).
// Fail /readyz first, stop accepting connections, let in-flight requests finish, close the database
// pool, then exit.
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  httpServer.close((err) => {
    // Stop probing and close upstream connections first, then the database they report into.
    upstreams
      .stop()
      .then(() => pool.end())
      .catch((poolErr: unknown) => logger.error({ err: poolErr }, "shutdown cleanup failed"))
      .finally(() => process.exit(err ? 1 : 0));
  });
  // Safety net: leave before the kubelet kills us if some request never finishes.
  setTimeout(() => {
    logger.error("forced exit: requests still running after 10 s");
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
