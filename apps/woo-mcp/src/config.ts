import { z } from "zod";

// All configuration comes from environment variables (12-factor). Secrets and the store URL have
// no defaults, so a missing one stops the process at start instead of failing later.
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // The token the gateway must present. The minimum length rules out values like "changeme".
  MCP_AUTH_TOKEN: z.string().min(16, "must be at least 16 characters"),
  // In-cluster address of the WordPress Service, e.g. http://platform-store-wordpress
  WC_BASE_URL: z.string().url("must be a URL such as http://platform-store-wordpress"),
  // The WordPress user (role shop_manager) and its Application Password.
  WC_USERNAME: z.string().min(1),
  WC_APP_PASSWORD: z.string().min(1),
  // Upper bound for ONE call to the store, so a hung store cannot hang the caller.
  WC_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
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
