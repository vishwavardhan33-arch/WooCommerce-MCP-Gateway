import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./tools/context.js";
import { registerInfoTools } from "./tools/info.js";
import { registerRateTools } from "./tools/rates.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

// Called once PER HTTP REQUEST (see app.ts): the server is stateless, so nothing is remembered
// between requests and any replica can answer any request.
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerRateTools(server, ctx);
  registerInfoTools(server, ctx);
  return server;
}
