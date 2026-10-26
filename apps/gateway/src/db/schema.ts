// The source of truth for the database shape. `npm run db:generate` compares this file with the
// previous migration and writes the SQL for the difference into ./drizzle; the service applies
// those SQL files when it starts (see migrate.ts).
import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// Enums are enforced by Postgres itself, so a typo like "adnim" can never be stored.
export const roleEnum = pgEnum("user_role", ["admin", "member"]);
// "bearer" = the gateway sends `Authorization: Bearer <credential>` to the upstream (what woo-mcp expects).
export const authTypeEnum = pgEnum("mcp_auth_type", ["none", "bearer"]);
// Result of the gateway's last health check of an upstream.
export const serverStatusEnum = pgEnum("mcp_server_status", ["unknown", "up", "down"]);

export type Role = (typeof roleEnum.enumValues)[number];

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Always lower-case (see validation.ts), so UNIQUE means "one account per person".
  email: text("email").notNull().unique(),
  // argon2id string; it already contains the salt and the cost settings.
  passwordHash: text("password_hash").notNull(),
  // Least privilege by default: nobody becomes admin by forgetting to set a role.
  role: roleEnum("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  role: roleEnum("role").notNull().default("member"),
  // sha256 of the token in the invite link. The link itself is shown once and never stored.
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // NULL = still usable. Setting it is what makes the link one-time.
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // HMAC-SHA256(SESSION_SECRET, cookie token). A leaked database alone cannot be turned into cookies.
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // A label the owner picks ("claude-desktop on my laptop") so they know which key to revoke.
  name: text("name").notNull(),
  // First characters of the key: safe to display, lets people recognise a key in a list.
  keyPrefix: text("key_prefix").notNull(),
  // sha256 hex of the full key. The key itself is shown once at creation and never stored.
  keyHash: text("key_hash").notNull().unique(),
  // Revocation is a timestamp, not a DELETE, so we keep a record that the key existed.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Upstream MCP servers the gateway forwards to.
export const mcpServers = pgTable("mcp_servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  url: text("url").notNull(),
  authType: authTypeEnum("auth_type").notNull().default("none"),
  // The upstream credential encrypted with AES-256-GCM, stored as base64(iv || authTag || ciphertext).
  // NULL when authType is "none". The encrypt/decrypt code arrives with the server-management task.
  credentialEnc: text("credential_enc"),
  enabled: boolean("enabled").notNull().default(true),
  // Upper bound for ONE upstream call, so a hung upstream cannot hang a client.
  timeoutMs: integer("timeout_ms").notNull().default(15000),
  status: serverStatusEnum("status").notNull().default("unknown"),
  // When `status` last CHANGED (not when it was last checked): answers "down for how long?".
  statusSince: timestamp("status_since", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Append-only record of who did what. Nothing writes to it yet; the gateway's /mcp task will.
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // set null (see migration): deleting a user or key must not erase the history of what they did.
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  target: text("target"),
  ok: boolean("ok").notNull(),
  detail: jsonb("detail"),
});

// Admin switch for one tool of one upstream server. No row = the tool is allowed.
export const toolPolicies = pgTable(
  "tool_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One policy per (server, tool): a second one would make "which one wins?" ambiguous.
  (t) => [unique().on(t.serverId, t.toolName)],
);
