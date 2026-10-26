import type { Role } from "../db/schema.js";

// WHO is making MCP calls. The gateway server is built around one of these, so every permission
// check and audit record can answer "on whose behalf?".
export interface Principal {
  userId: string;
  role: Role;
  /** The API key used, or null when the caller did not use one (the chat agent acts as a logged-in user). */
  apiKeyId: string | null;
  /** Where the call came from, stored in the audit record: an external MCP client or our own chat agent. */
  source: "mcp" | "chat";
}
