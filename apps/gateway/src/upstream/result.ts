import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// MCP convention: a failed tool call is a normal result with isError: true and a message the model
// can read and act on, not a protocol error or a crash. Everything the gateway cannot do for a
// client is reported this way.
export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
