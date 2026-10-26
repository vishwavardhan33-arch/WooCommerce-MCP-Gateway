import { pino, type Logger } from "pino";

export type { Logger };

// JSON lines on stdout: the 12-factor way, collected by the cluster. Never log tokens, note titles
// or note text; log what happened and how long it took.
export function createLogger(level: string): Logger {
  return pino({ level, base: { service: "mcp-notes" } });
}
