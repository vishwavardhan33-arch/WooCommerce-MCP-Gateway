import { createApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { FrankfurterRates } from "./fx/frankfurter.js";
import { StaticRates } from "./fx/staticRates.js";
import { createLogger } from "./logger.js";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  // No configured logger yet: print the problem (variable names only) and stop.
  console.error(JSON.stringify({ level: "fatal", msg: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}

const logger = createLogger(config.LOG_LEVEL);
const rates =
  config.FX_MODE === "static"
    ? new StaticRates()
    : new FrankfurterRates({ baseUrl: config.FRANKFURTER_BASE_URL, timeoutMs: config.FX_TIMEOUT_MS });

let shuttingDown = false;
const app = createApp({
  authToken: config.MCP_AUTH_TOKEN,
  ctx: { rates, logger },
  isShuttingDown: () => shuttingDown,
});

const httpServer = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, mode: config.FX_MODE }, "mcp-fx listening");
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
