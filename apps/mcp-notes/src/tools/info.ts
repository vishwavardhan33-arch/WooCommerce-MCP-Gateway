import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";
import type { ToolContext } from "./context.js";
import { guard } from "./result.js";

// Every server in this platform exposes a tool called exactly `server_info`. That is deliberate:
// when the gateway merges all servers into one tool list, these identical names are a REAL name
// collision, which is what its namespacing (<slug>__<tool>) exists to solve.
export function registerInfoTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "server_info",
    {
      title: "Server info",
      description: "Describe this MCP server: its version and how many notes it holds. Also a quick check that its database works.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    // No inputSchema: the SDK calls the callback with no arguments.
    async () =>
      guard(ctx, "server_info", () => ({
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        notes: { count: ctx.store.count() },
      })),
  );
}
