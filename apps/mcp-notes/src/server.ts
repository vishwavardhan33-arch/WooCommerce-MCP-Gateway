import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./tools/context.js";
import { registerInfoTools } from "./tools/info.js";
import { registerNoteTools } from "./tools/notes.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

// Called once PER HTTP REQUEST (see app.ts). The MCP server is stateless: it remembers nothing
// between requests. The notes themselves live in SQLite, which is what makes them persistent.
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerNoteTools(server, ctx);
  registerInfoTools(server, ctx);
  return server;
}
