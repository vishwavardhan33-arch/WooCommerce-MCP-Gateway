import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FxError } from "../fx/types.js";
import type { ToolContext } from "./context.js";

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

// MCP convention: a failed tool call is a normal result with isError: true and a message the
// model can read and act on, not a protocol error or a crash.
export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Turns anything that can go wrong into a sentence the model (and a human) can act on. */
export function describeError(err: unknown): string {
  if (err instanceof FxError) {
    switch (err.kind) {
      case "timeout":
        return `${err.message} Try again in a moment.`;
      case "unreachable":
        return `${err.message} The server may have no internet access; if so, it can be started with FX_MODE=static.`;
      case "unknown_currency":
      case "invalid_request":
        return err.message; // the caller can fix this: use a different code or date
      default:
        return `${err.message} Retrying later may help.`;
    }
  }
  return `Unexpected error in mcp-fx: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Wraps one tool call: runs it, times it, logs it, and converts any failure into an isError result.
 * The log line has the tool name, outcome and duration only: no arguments, no results.
 */
export async function guard(ctx: ToolContext, tool: string, run: () => Promise<unknown>): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const data = await run();
    ctx.logger.info({ tool, ok: true, durationMs: Date.now() - started }, "tool call");
    return ok(data);
  } catch (err) {
    const message = describeError(err);
    ctx.logger.warn({ tool, ok: false, durationMs: Date.now() - started, error: message }, "tool call failed");
    if (!(err instanceof FxError)) ctx.logger.error({ err }, "unexpected error in tool");
    return fail(message);
  }
}
