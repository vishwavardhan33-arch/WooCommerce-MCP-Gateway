import { z } from "zod";

// All configuration comes from environment variables (12-factor). The token has no default, so a
// missing one stops the process at start instead of leaving the server open.
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // The token the gateway must present. The minimum length rules out values like "changeme".
  MCP_AUTH_TOKEN: z.string().min(16, "must be at least 16 characters"),
  // Where the SQLite file lives. In the cluster this is a mounted volume (emptyDir or PVC), because
  // the container's own filesystem is read-only. For local development use e.g. ./notes.db
  NOTES_DB_PATH: z.string().min(1).default("/data/notes.db"),
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
