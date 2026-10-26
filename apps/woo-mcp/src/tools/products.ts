import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { trimProduct } from "../wc/trim.js";
import type { WcProduct } from "../wc/types.js";
import type { ToolContext } from "./context.js";
import { guard } from "./result.js";

export function registerProductTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description:
        "List products in the store. Returns id, name, sku, price, status, stock status and storefront URL. " +
        "Use `search` to find a product by name or SKU.",
      inputSchema: {
        search: z.string().max(200).optional().describe("Only products whose name or SKU matches this text."),
        status: z
          .enum(["any", "publish", "draft", "private", "pending"])
          .default("any")
          .describe("Filter by publication status. publish = visible on the storefront."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of products to return."),
      },
      // Read-only: never changes the store. Closed world: it only talks to this one store.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ search, status, limit }) =>
      guard(ctx, "list_products", async () => {
        const products = await ctx.wc.get<WcProduct[]>("/wc/v3/products", { search, status, per_page: limit });
        return {
          count: products.length,
          products: products.map(trimProduct),
          ...(products.length === limit ? { note: "There may be more products; raise `limit` or narrow `search`." } : {}),
        };
      }),
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description:
        "Create a simple product. It is published immediately by default, so it appears on the storefront. " +
        "Returns the new product including its storefront URL. SKUs must be unique.",
      inputSchema: {
        name: z.string().min(1).max(200).describe("Product name shown on the storefront."),
        price: z.number().min(0).finite().describe("Regular price as a plain number in the store currency, e.g. 19.99."),
        description: z.string().max(5000).optional().describe("Optional longer description."),
        sku: z.string().min(1).max(100).optional().describe("Optional unique stock-keeping unit."),
        status: z
          .enum(["publish", "draft"])
          .default("publish")
          .describe("publish = visible on the storefront now; draft = saved but hidden."),
      },
      // Additive (adds a product, overwrites nothing) but not idempotent: calling it twice creates two.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, price, description, sku, status }) =>
      guard(ctx, "create_product", async () => {
        const created = await ctx.wc.post<WcProduct>("/wc/v3/products", {
          name,
          type: "simple",
          regular_price: price.toFixed(2),
          status,
          ...(description ? { description } : {}),
          ...(sku ? { sku } : {}),
        });
        return { created: trimProduct(created) };
      }),
  );
}
