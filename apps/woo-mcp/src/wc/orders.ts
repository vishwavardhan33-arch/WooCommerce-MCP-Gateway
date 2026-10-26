import { parseWcGmt, type Window } from "../time.js";
import type { WcClient } from "./client.js";
import type { WcOrder } from "./types.js";

const DAY_MS = 86_400_000;
const PER_PAGE = 100;

export interface OrdersInWindow {
  orders: WcOrder[]; // newest first
  /** True when we stopped at the page cap, so older matching orders may exist. */
  truncated: boolean;
}

const asQueryDate = (ms: number) => new Date(ms).toISOString().slice(0, 19); // no "Z"

// Correctness does not depend on how WooCommerce interprets its `after`/`before` parameters
// (store time or UTC). We ask for a window one day wider on each side, which covers any
// ambiguity (zone offsets are at most 14 h), and then keep exactly the orders whose
// date_created_gmt (an unambiguous UTC value) lies inside [startMs, endMs).
export async function fetchOrdersInWindow(
  wc: WcClient,
  opts: { window: Window; status?: string; maxPages?: number },
): Promise<OrdersInWindow> {
  const { startMs, endMs } = opts.window;
  const maxPages = opts.maxPages ?? 5;
  const fetched: WcOrder[] = [];
  let truncated = true;

  for (let page = 1; page <= maxPages; page++) {
    const batch = await wc.get<WcOrder[]>("/wc/v3/orders", {
      after: asQueryDate(startMs - DAY_MS),
      before: asQueryDate(endMs + DAY_MS),
      status: opts.status ?? "any",
      orderby: "date",
      order: "desc",
      per_page: PER_PAGE,
      page,
    });
    fetched.push(...batch);
    if (batch.length < PER_PAGE) {
      truncated = false;
      break;
    }
  }

  const orders = fetched.filter((o) => {
    const t = parseWcGmt(o.date_created_gmt);
    return t >= startMs && t < endMs;
  });
  return { orders, truncated };
}
