import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import type { Logger } from "../logger.js";
import type { Principal } from "./principal.js";
import { summarizeArgs, truncate } from "./redact.js";

// ok     = the upstream tool ran and reported success
// error  = it failed: the tool reported an error, or the gateway could not reach / finish the call
// denied = an admin policy blocked it; the upstream was never contacted
export type AuditStatus = "ok" | "error" | "denied";

const MAX_ERROR_LENGTH = 300;

export interface CallRecord {
  principal: Principal;
  /** The name the client asked for, exactly as sent (it may not exist). */
  requestedName: string;
  /** Server slug and the upstream's own tool name; null when the name did not match anything. */
  server: string | null;
  tool: string | null;
  durationMs: number;
  status: AuditStatus;
  result: CallToolResult;
  args: Record<string, unknown> | undefined;
}

// The first text block of an error result: that is where tools and the gateway put the message.
function errorText(result: CallToolResult): string | null {
  for (const block of result.content) {
    if (block.type === "text") return truncate(block.text, MAX_ERROR_LENGTH);
  }
  return null;
}

// Writes ONE row per tool call. Mapping onto the audit_log columns:
//   actor_user_id / api_key_id  who (api_key_id is null for the chat agent)
//   action = "tool.call", target = the requested name, ok = status is "ok"
//   detail = { source, server, tool, durationMs, status, error, args }
// A failure to write the row is logged but never fails the call: the user's request already
// happened, and losing a log line is better than turning a working call into an error.
export async function writeCallAudit(db: Db, logger: Logger, record: CallRecord): Promise<void> {
  const { principal } = record;
  try {
    await db.insert(auditLog).values({
      actorUserId: principal.userId,
      apiKeyId: principal.apiKeyId,
      action: "tool.call",
      target: truncate(record.requestedName, 200),
      ok: record.status === "ok",
      detail: {
        source: principal.source,
        server: record.server,
        tool: record.tool,
        durationMs: record.durationMs,
        status: record.status,
        error: record.status === "ok" ? null : errorText(record.result),
        args: summarizeArgs(record.args),
      },
    });
  } catch (err) {
    logger.error({ err, requestedName: record.requestedName }, "audit write failed");
  }
}
