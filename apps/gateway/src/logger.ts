import { pino, type Logger } from "pino";

export type { Logger };

// JSON lines on stdout: the 12-factor way, collected by the cluster. Never log passwords, session
// tokens, API keys or invite tokens; log what happened, not the secret that was involved.
export function createLogger(level: string): Logger {
  return pino({ level, base: { service: "gateway" } });
}
