import { z } from "zod";
import { emailSchema, passwordSchema } from "./validation.js";

const emptyAsUndefined = <T extends z.ZodTypeAny>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner);

// All configuration comes from environment variables (12-factor). Secrets have no defaults, so a
// missing one stops the process at start instead of failing later.
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // The Helm chart builds this from the gateway-db Secret; the password is part of the URL.
  DATABASE_URL: z.string().url("must be a URL such as postgres://user:password@host:5432/gateway"),
  // Keys the HMAC that protects session tokens in the database (see auth/sessions.ts).
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  // The first admin account, created on first start if no admin exists yet.
  ADMIN_BOOTSTRAP_EMAIL: emailSchema,
  ADMIN_BOOTSTRAP_PASSWORD: passwordSchema,
  // Where users open the dashboard; invite links are built from it, e.g. http://app.localtest.me
  PUBLIC_BASE_URL: z.string().url("must be a URL such as http://app.localtest.me"),
  // z.coerce.boolean() would turn the string "false" into true (any non-empty string is truthy),
  // so booleans are parsed explicitly. Secure cookies are the default; the local chart turns them
  // off because k3d serves plain http.
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Encrypts the credentials of upstream MCP servers in the database (AES-256-GCM needs a 32-byte key,
  // written as 64 hex characters). Keep it out of the database: if it lived next to the data it
  // protects, encrypting would add nothing.
  CREDENTIAL_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (generate with: openssl rand -hex 32)"),
  // Hostnames the gateway may call even though they resolve to a private / cluster-internal address,
  // comma-separated; "*.suffix" matches any subdomain. Example: platform-woo-mcp,*.svc.cluster.local
  // Empty by default: private addresses are blocked unless explicitly listed (see upstream/ssrf.ts).
  UPSTREAM_ALLOWED_HOSTS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0),
    ),
  // The chat page talks to ANY OpenAI-compatible chat-completions API (Groq, OpenRouter, Gemini's
  // compatibility endpoint, a local Ollama...), so you can pick one that costs nothing. All three
  // must be set to enable chat; with none set the rest of the gateway works and chat says it is not
  // configured. Empty strings count as "not set" (Helm and .env files often produce them).
  LLM_BASE_URL: emptyAsUndefined(z.string().url().optional()),
  LLM_MODEL: emptyAsUndefined(z.string().min(1).optional()),
  LLM_API_KEY: emptyAsUndefined(z.string().min(1).optional()),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
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
