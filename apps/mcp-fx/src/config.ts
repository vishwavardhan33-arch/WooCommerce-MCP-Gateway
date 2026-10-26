import { z } from "zod";

// All configuration comes from environment variables (12-factor). The token has no default, so a
// missing one stops the process at start instead of leaving the server open.
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // The token the gateway must present. The minimum length rules out values like "changeme".
  MCP_AUTH_TOKEN: z.string().min(16, "must be at least 16 characters"),
  // live   = ask Frankfurter (needs internet access).
  // static = a small built-in table: works offline and gives the same answer every time, which is
  //          what you want for demos and tests.
  FX_MODE: z.enum(["live", "static"]).default("live"),
  // Frankfurter's public API (free, no key). Only used when FX_MODE=live.
  FRANKFURTER_BASE_URL: z.string().url().default("https://api.frankfurter.dev/v1"),
  // Upper bound for ONE call to Frankfurter, so a hung API cannot hang the caller.
  FX_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Variable names and reasons only, never the values: they may be secrets.
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration - ${problems.join("; ")}`);
  }
  return result.data;
}
