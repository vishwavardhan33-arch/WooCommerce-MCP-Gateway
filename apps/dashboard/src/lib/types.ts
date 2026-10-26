// The shapes the gateway's REST API returns. Dates arrive as ISO strings.
export type Role = "admin" | "member";

export interface User {
  id: string;
  email: string;
  role: Role;
}

export type ServerStatus = "unknown" | "up" | "down";
export type AuthType = "none" | "bearer";

// Note what is NOT here: any credential. The API never returns one, only `hasCredential`.
export interface Server {
  id: string;
  slug: string;
  url: string;
  authType: AuthType;
  hasCredential: boolean;
  enabled: boolean;
  timeoutMs: number;
  status: ServerStatus;
  statusSince: string;
  /** Admins only; null for members. */
  lastError: string | null;
  toolCount: number;
  createdAt: string;
}

export interface ServerInput {
  slug: string;
  url: string;
  authType: AuthType;
  credential?: string;
  timeoutMs: number;
  enabled: boolean;
}

export interface ToolGroup {
  slug: string;
  status: ServerStatus;
  tools: { name: string; original: string; description: string }[];
}

export interface TeamUser extends User {
  createdAt: string;
  activeKeys: number;
}

export interface InviteRow {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  status: "pending" | "accepted" | "expired";
}

export interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type AuditStatus = "ok" | "error" | "denied";

export interface AuditEntry {
  id: string;
  createdAt: string;
  userEmail: string | null;
  keyName: string | null;
  keyPrefix: string | null;
  action: string;
  target: string | null;
  ok: boolean;
  detail: {
    source: "mcp" | "chat";
    server: string | null;
    tool: string | null;
    durationMs: number;
    status: AuditStatus;
    error: string | null;
    args: Record<string, string | number | boolean | null>;
  } | null;
}

export interface AuditSummaryRow {
  server: string;
  calls: number;
  errors: number;
  denied: number;
  avgMs: number;
  p95Ms: number;
}

export interface AuditFilters {
  server: string;
  status: string;
  source: string;
  tool: string;
  userId: string;
  limit: number;
  offset: number;
}

// What the chat endpoint streams (one per Server-Sent Event).
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; isError: boolean; durationMs: number; result: string; truncated: boolean }
  | { type: "retry"; attempt: number; waitMs: number }
  | { type: "error"; message: string }
  | { type: "done" };
