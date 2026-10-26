import { createApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { WcClient } from "./wc/client.js";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  // No configured logger yet: print the problem (variable names only) and stop.
  console.error(JSON.stringify({ level: "fatal", msg: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}

const logger = createLogger(config.LOG_LEVEL);
const wc = new WcClient({
  baseUrl: config.WC_BASE_URL,
  username: config.WC_USERNAME,
  appPassword: config.WC_APP_PASSWORD,
  timeoutMs: config.WC_TIMEOUT_MS,
});

let shuttingDown = false;
const app = createApp({
  authToken: config.MCP_AUTH_TOKEN,
  ctx: { wc, logger, now: () => new Date() },
  isShuttingDown: () => shuttingDown,
});

const httpServer = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "woo-mcp listening");
});

// Graceful shutdown: Kubernetes sends SIGTERM, then SIGKILL after terminationGracePeriodSeconds (30 s).
// Fail /readyz first, stop accepting connections, let in-flight requests finish, then exit.
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  httpServer.close((err) => process.exit(err ? 1 : 0));
  // Safety net: leave before the kubelet kills us if some request never finishes.
  setTimeout(() => {
    logger.error("forced exit: requests still running after 10 s");
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
