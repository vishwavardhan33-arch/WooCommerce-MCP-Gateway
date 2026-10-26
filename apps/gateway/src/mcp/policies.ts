import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { toolPolicies } from "../db/schema.js";

// Policies are keyed by the server's id and the UPSTREAM's own tool name (not the published
// "slug__tool" name): that name is stable even if the slug is renamed or the name gets shortened.
// A server id is a UUID (no ":"), so "<uuid>:<tool>" cannot be confused with another pair.
export const policyKey = (serverId: string, originalTool: string): string => `${serverId}:${originalTool}`;

// "No row" means allowed, so only the DISABLED rows matter. Read from the database on every
// request (one small query): an admin switching a tool off takes effect on the very next call,
// with no cache to invalidate.
export async function loadDisabledTools(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ serverId: toolPolicies.serverId, toolName: toolPolicies.toolName })
    .from(toolPolicies)
    .where(eq(toolPolicies.enabled, false));
  return new Set(rows.map((r) => policyKey(r.serverId, r.toolName)));
}
