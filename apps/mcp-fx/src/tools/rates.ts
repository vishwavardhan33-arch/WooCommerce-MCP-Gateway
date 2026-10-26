import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isRealDate } from "../fx/dates.js";
import { round } from "../fx/types.js";
import type { ToolContext } from "./context.js";
import { guard } from "./result.js";

// "usd", " USD " and "USD" all mean the same currency, so codes are trimmed and upper-cased
// BEFORE anything else sees them. Three letters only: that is the ISO 4217 shape.
const currency = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "must be a 3-letter currency code such as USD")
    .toUpperCase()
    .describe(what);

const optionalDate = z
  .string()
  .refine(isRealDate, "must be a real date written YYYY-MM-DD")
  .optional()
  .describe("Optional day (YYYY-MM-DD) for a historical rate. Omit for the latest rate.");

export function registerRateTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_rate",
    {
      title: "Get exchange rate",
      description:
        "Get the exchange rate between two currencies: how many units of `to` one unit of `from` buys. " +
        "Returns the rate, the day it is for and where it came from.",
      inputSchema: {
        from: currency("Currency to convert from, e.g. USD."),
        to: currency("Currency to convert to, e.g. EUR."),
        date: optionalDate,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ from, to, date }) => guard(ctx, "get_rate", () => ctx.rates.rate(from, to, date)),
  );

  server.registerTool(
    "convert",
    {
      title: "Convert an amount",
      description:
        "Convert an amount of money from one currency to another. Returns the converted amount, the rate used and the day it is for.",
      inputSchema: {
        amount: z.number().finite().min(0).max(1e12).describe("Amount in the `from` currency, e.g. 100."),
        from: currency("Currency to convert from, e.g. USD."),
        to: currency("Currency to convert to, e.g. EUR."),
        date: optionalDate,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ amount, from, to, date }) =>
      guard(ctx, "convert", async () => {
        const r = await ctx.rates.rate(from, to, date);
        // The multiplication happens here, not at the API, so the arithmetic is the same in live and static mode.
        return { amount, from, to, rate: r.rate, result: round(amount * r.rate, 4), date: r.date, source: r.source };
      }),
  );
}
