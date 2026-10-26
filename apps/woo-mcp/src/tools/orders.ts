import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fixedOffsetTimezone, formatLocal, PERIODS, periodWindow } from "../time.js";
import { fetchOrdersInWindow } from "../wc/orders.js";
import { loadStoreInfo } from "../wc/store.js";
import { detailOrder, summarizeOrder } from "../wc/trim.js";
import type { WcOrder } from "../wc/types.js";
import type { ToolContext } from "./context.js";
import { guard } from "./result.js";

export const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;

export function registerOrderTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List orders placed in a period, newest first. Periods use the STORE's own time zone: " +
        "today, yesterday, or last_7_days (today plus the 6 days before it). " +
        "Use this for questions like 'what orders came in today?'. Customer contact details are not included.",
      inputSchema: {
        period: z.enum(PERIODS).default("today").describe("Which days to look at, in the store's time zone."),
        status: z.enum(["any", ...ORDER_STATUSES]).default("any").describe("Only orders in this status."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of orders to return."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ period, status, limit }) =>
      guard(ctx, "list_orders", async () => {
        const { timezone: tz } = await loadStoreInfo(ctx.wc);
        const window = periodWindow(period, ctx.now(), tz);
        const { orders, truncated } = await fetchOrdersInWindow(ctx.wc, { window, status });
        const shown = orders.slice(0, limit);
        return {
          period,
          timezone: tz.label,
          from: formatLocal(window.startMs, tz),
          until: formatLocal(window.endMs, tz), // exclusive
          matched: orders.length,
          shown: shown.length,
          ...(truncated ? { warning: "Result was cut off at the page limit; older matching orders may exist." } : {}),
          orders: shown.map((o) => summarizeOrder(o, tz)),
        };
      }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get one order by its id: status, total, customer name, payment method and line items.",
      inputSchema: {
        id: z.number().int().positive().describe("The order id (as shown by list_orders)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      guard(
        ctx,
        "get_order",
        async () => {
          const [{ timezone: tz }, order] = await Promise.all([
            loadStoreInfo(ctx.wc),
            ctx.wc.get<WcOrder>(`/wc/v3/orders/${id}`),
          ]);
          return detailOrder(order, tz);
        },
        `Order ${id} was not found.`,
      ),
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description:
        "Change the status of an order. Side effects: cancelling an order restores stock and the store may " +
        "email the customer; 'refunded' only sets the status, it does not return any money.",
      inputSchema: {
        id: z.number().int().positive().describe("The order id."),
        status: z.enum(ORDER_STATUSES).describe("The new status."),
      },
      // Overwrites the previous status, so it is not "additive": destructiveHint true tells clients to
      // treat it with care. Setting the same status twice changes nothing more, hence idempotent.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, status }) =>
      guard(
        ctx,
        "update_order_status",
        async () => {
          // Change the order FIRST. The time zone is only needed to format the reply, so if looking
          // it up fails afterwards we still report the success (in UTC) instead of an error for a
          // change that really happened.
          const order = await ctx.wc.put<WcOrder>(`/wc/v3/orders/${id}`, { status });
          const tz = await loadStoreInfo(ctx.wc).then(
            (store) => store.timezone,
            () => fixedOffsetTimezone(0),
          );
          return { updated: summarizeOrder(order, tz) };
        },
        `Order ${id} was not found.`,
      ),
  );
}
