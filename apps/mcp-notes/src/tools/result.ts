import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "./context.js";

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

// MCP convention: a failed tool call is a normal result with isError: true and a message the
// model can read and act on, not a protocol error or a crash.
export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** An EXPECTED failure (e.g. "no such note"): the message goes to the caller as written. */
export class NotesError extends Error {}

/** Turns anything that can go wrong into a sentence the model (and a human) can act on. */
export function describeError(err: unknown): string {
  if (err instanceof NotesError) return err.message;
  // better-sqlite3 errors carry a code such as SQLITE_FULL or SQLITE_READONLY.
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_")) {
    return `The notes database failed (${code}): ${err instanceof Error ? err.message : String(err)}. This is a problem on the server; retrying will not help until it is fixed.`;
  }
  return `Unexpected error in mcp-notes: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Wraps one tool call: runs it, times it, logs it, and converts any failure into an isError result.
 * The log line has the tool name, outcome and duration only: no arguments, no notes.
 */
export async function guard(ctx: ToolContext, tool: string, run: () => unknown): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const data = await run();
    ctx.logger.info({ tool, ok: true, durationMs: Date.now() - started }, "tool call");
    return ok(data);
  } catch (err) {
    const message = describeError(err);
    ctx.logger.warn({ tool, ok: false, durationMs: Date.now() - started, error: message }, "tool call failed");
    if (!(err instanceof NotesError)) ctx.logger.error({ err }, "unexpected error in tool");
    return fail(message);
  }
}
