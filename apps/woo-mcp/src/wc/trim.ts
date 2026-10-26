import { formatLocal, parseWcGmt, type StoreTimezone } from "../time.js";
import type { WcOrder, WcProduct } from "./types.js";

// Trimmed outputs: small, flat, and free of personal data the model does not need. Order outputs
// carry the customer's NAME only (no email, phone or address), because the model's context may
// be sent to a third-party LLM provider.

export function trimProduct(p: WcProduct) {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku || null,
    price: p.price || null,
    status: p.status,
    stock_status: p.stock_status,
    url: p.permalink,
  };
}

function customerName(o: WcOrder): string | null {
  const name = [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(" ");
  return name || null;
}

function placedAt(o: WcOrder, tz: StoreTimezone): string | null {
  const ms = parseWcGmt(o.date_created_gmt);
  return Number.isFinite(ms) ? formatLocal(ms, tz) : null;
}

/** One order, short form, for lists. */
export function summarizeOrder(o: WcOrder, tz: StoreTimezone) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    placed_at: placedAt(o, tz),
    total: o.total,
    currency: o.currency,
    customer: customerName(o),
    items: o.line_items.map((i) => `${i.quantity} x ${i.name}`),
  };
}

/** One order, long form, for get_order. */
export function detailOrder(o: WcOrder, tz: StoreTimezone) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    placed_at: placedAt(o, tz),
    total: o.total,
    currency: o.currency,
    customer: customerName(o),
    payment_method: o.payment_method_title || null,
    customer_note: o.customer_note || null,
    line_items: o.line_items.map((i) => ({
      name: i.name,
      sku: i.sku || null,
      quantity: i.quantity,
      total: i.total,
    })),
  };
}
