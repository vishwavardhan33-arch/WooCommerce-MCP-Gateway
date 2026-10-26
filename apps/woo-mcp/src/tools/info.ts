import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";
import { loadStoreInfo } from "../wc/store.js";
import type { ToolContext } from "./context.js";
import { guard } from "./result.js";

export function registerInfoTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "server_info",
    {
      title: "Server info",
      description:
        "Describe this MCP server and the store behind it: server version, store name, storefront URL and the time zone used for 'today'. " +
        "Also a quick way to check that the store is reachable.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    // No inputSchema: the SDK calls the callback with no arguments.
    async () =>
      guard(ctx, "server_info", async () => {
        const store = await loadStoreInfo(ctx.wc);
        return {
          server: { name: SERVER_NAME, version: SERVER_VERSION },
          store: { name: store.name, url: store.url, timezone: store.timezone.label },
        };
      }),
  );
}
