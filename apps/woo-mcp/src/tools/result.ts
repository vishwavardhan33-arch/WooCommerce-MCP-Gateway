import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { WcApiError } from "../wc/client.js";
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
export function describeError(err: unknown, notFound?: string): string {
  if (err instanceof WcApiError) {
    if (err.code === "timeout") return "The store did not answer in time. Try again in a moment.";
    if (err.status === 0) return `The store could not be reached: ${err.message}`;
    if (err.code === "invalid_response") return `The store's REST API misbehaved: ${err.message}`;
    if (err.status === 401 || err.status === 403) {
      return `The store rejected this server's credentials (HTTP ${err.status}): ${err.message}. This is a configuration problem on the server; retrying will not help.`;
    }
    if (err.status === 404 && notFound) return notFound;
    if (err.status >= 400 && err.status < 500) {
      return `The store rejected the request: ${err.message}${err.code ? ` (${err.code})` : ""}`;
    }
    return `The store returned an error (HTTP ${err.status}): ${err.message}`;
  }
  return `Unexpected error in woo-mcp: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Wraps one tool call: runs it, times it, logs it, and converts any failure into an isError result.
 * The log line has the tool name, outcome and duration only: no arguments, no results.
 */
export async function guard(
  ctx: ToolContext,
  tool: string,
  run: () => Promise<unknown>,
  notFound?: string,
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const data = await run();
    ctx.logger.info({ tool, ok: true, durationMs: Date.now() - started }, "tool call");
    return ok(data);
  } catch (err) {
    const message = describeError(err, notFound);
    ctx.logger.warn({ tool, ok: false, durationMs: Date.now() - started, error: message }, "tool call failed");
    if (!(err instanceof WcApiError)) ctx.logger.error({ err }, "unexpected error in tool");
    return fail(message);
  }
}
