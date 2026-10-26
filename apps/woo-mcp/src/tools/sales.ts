import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatLocal, PERIODS, periodWindow } from "../time.js";
import { fetchOrdersInWindow } from "../wc/orders.js";
import { loadStoreInfo } from "../wc/store.js";
import type { ToolContext } from "./context.js";
import { guard } from "./result.js";

// Statuses that represent money actually earned or still expected. Cancelled, refunded, failed
// and pending (unpaid) orders are counted in by_status but not in revenue.
const REVENUE_STATUSES = new Set(["processing", "completed", "on-hold"]);

export function registerSalesTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_sales_summary",
    {
      title: "Get sales summary",
      description:
        "Summarise sales for a period in the store's time zone: number of orders, revenue, and orders per status. " +
        "Revenue counts processing, completed and on-hold orders only.",
      inputSchema: {
        period: z.enum(PERIODS).default("today").describe("Which days to summarise, in the store's time zone."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period }) =>
      guard(ctx, "get_sales_summary", async () => {
        const { timezone: tz } = await loadStoreInfo(ctx.wc);
        const window = periodWindow(period, ctx.now(), tz);
        const { orders, truncated } = await fetchOrdersInWindow(ctx.wc, { window });

        const byStatus: Record<string, number> = {};
        let revenue = 0;
        let revenueOrders = 0;
        for (const o of orders) {
          byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
          if (REVENUE_STATUSES.has(o.status)) {
            revenue += Number(o.total);
            revenueOrders += 1;
          }
        }
        return {
          period,
          timezone: tz.label,
          from: formatLocal(window.startMs, tz),
          until: formatLocal(window.endMs, tz), // exclusive
          orders_total: orders.length,
          orders_counted_as_revenue: revenueOrders,
          revenue: revenue.toFixed(2),
          currency: orders[0]?.currency ?? null,
          by_status: byStatus,
          ...(truncated ? { warning: "Result was cut off at the page limit; the numbers are incomplete." } : {}),
        };
      }),
  );
}
