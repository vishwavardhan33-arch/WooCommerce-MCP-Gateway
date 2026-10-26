// A fake store for tests: an in-memory stand-in for the WordPress/WooCommerce REST API, plugged
// into WcClient through its `fetchImpl`. It records every request so tests can assert what the
// server sent, and it behaves like the real thing in the ways that matter here:
//   - the site index is public, everything else needs the Application Password AND an
//     X-Forwarded-Proto: https header (WordPress ignores app passwords on plain HTTP);
//   - it IGNORES the order date filters, so tests prove the server filters exactly by itself;
//   - it returns far more fields than the server should pass on (addresses, emails, _links...).

export interface FakeOrderInput {
  id: number;
  status: string;
  gmt: string; // date_created_gmt as WooCommerce prints it: UTC, no "Z"
  total: string;
  first?: string;
  last?: string;
  items?: { name: string; quantity: number; total: string }[];
}

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface FakeWcOptions {
  timezoneString?: string;
  gmtOffset?: string;
  orders?: FakeOrderInput[];
  username?: string;
  password?: string;
  /** Make every request fail like a refused connection. */
  networkError?: string;
  /** Make the store reject every authenticated request with this status (e.g. 500). */
  failAuthenticatedWith?: number;
}

const WC_ERROR = (status: number, code: string, message: string) => ({ status, body: { code, message, data: { status } } });

export function createFakeWc(opts: FakeWcOptions = {}) {
  const username = opts.username ?? "mcp-bot";
  const password = opts.password ?? "app-pass-123";
  const calls: FakeCall[] = [];
  const products: Record<string, unknown>[] = [];
  let nextProductId = 100;

  const orders = (opts.orders ?? []).map((o) => ({
    id: o.id,
    number: String(o.id),
    status: o.status,
    currency: "USD",
    total: o.total,
    date_created: o.gmt,
    date_created_gmt: o.gmt,
    payment_method_title: "Cash on delivery",
    customer_note: "",
    billing: { first_name: o.first ?? "", last_name: o.last ?? "", email: "private@example.com", phone: "555-0100", address_1: "1 Secret Street" },
    line_items: (o.items ?? [{ name: "Coffee Mug", quantity: 1, total: o.total }]).map((i) => ({ ...i, sku: "SEED-MUG", meta_data: [] })),
    meta_data: [{ id: 1, key: "_internal", value: "x" }],
    _links: { self: [{ href: "http://store.test/wp-json/wc/v3/orders" }] },
  }));

  const index = {
    name: "Demo Shop",
    description: "",
    url: "http://shop.test",
    home: "http://shop.test",
    gmt_offset: opts.gmtOffset ?? "0",
    timezone_string: opts.timezoneString ?? "",
    namespaces: ["wp/v2", "wc/v3"],
  };

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const route = (method: string, path: string, query: Record<string, string>, body: unknown): { status: number; body: unknown } => {
    if (path === "/wp-json/wc/v3/products" && method === "GET") {
      const perPage = Number(query.per_page ?? 10);
      const matching = products.filter(
        (p) =>
          (!query.status || query.status === "any" || p.status === query.status) &&
          (!query.search || String(p.name).toLowerCase().includes(query.search.toLowerCase())),
      );
      return { status: 200, body: matching.slice(0, perPage) };
    }
    if (path === "/wp-json/wc/v3/products" && method === "POST") {
      const input = body as { name: string; regular_price: string; sku?: string; status: string; description?: string };
      if (input.sku && products.some((p) => p.sku === input.sku)) {
        return WC_ERROR(400, "product_invalid_sku", "Invalid or duplicated SKU.");
      }
      const id = nextProductId++;
      const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const product = {
        id,
        name: input.name,
        slug,
        permalink: `http://shop.test/product/${slug}/`,
        sku: input.sku ?? "",
        price: input.regular_price,
        regular_price: input.regular_price,
        status: input.status,
        stock_status: "instock",
        description: input.description ?? "",
        meta_data: [{ id: 9, key: "_noise", value: "x" }],
        _links: { self: [] },
      };
      products.push(product);
      return { status: 201, body: product };
    }
    if (path === "/wp-json/wc/v3/orders" && method === "GET") {
      const perPage = Number(query.per_page ?? 10);
      const page = Number(query.page ?? 1);
      const matching = orders.filter((o) => !query.status || query.status === "any" || o.status === query.status);
      return { status: 200, body: matching.slice((page - 1) * perPage, page * perPage) };
    }
    const one = /^\/wp-json\/wc\/v3\/orders\/(\d+)$/.exec(path);
    if (one) {
      const order = orders.find((o) => o.id === Number(one[1]));
      if (!order) return WC_ERROR(404, "woocommerce_rest_shop_order_invalid_id", "Invalid ID.");
      if (method === "PUT") order.status = (body as { status: string }).status;
      return { status: 200, body: order };
    }
    return WC_ERROR(404, "rest_no_route", "No route was found matching the URL and request method.");
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const query = Object.fromEntries(url.searchParams.entries());
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path: url.pathname, query, body });

    if (opts.networkError) throw new Error(opts.networkError);

    if (url.pathname === "/wp-json/") return reply(200, index);

    const expected = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    if (headers.get("authorization") !== expected || headers.get("x-forwarded-proto") !== "https") {
      const e = WC_ERROR(401, "rest_forbidden", "Sorry, you are not allowed to do that.");
      return reply(e.status, e.body);
    }
    if (opts.failAuthenticatedWith) {
      return reply(opts.failAuthenticatedWith, { code: "internal_server_error", message: "boom" });
    }
    const result = route(method, url.pathname, query, body);
    return reply(result.status, result.body);
  };

  return { fetchImpl, calls, products, orders, username, password };
}

/** Orders around "now" = 2026-10-09T20:00:00Z for a store in Asia/Kolkata (UTC+5:30). */
export const KOLKATA_ORDERS: FakeOrderInput[] = [
  // 2026-10-10 00:30 in Kolkata -> today. (Still 2026-10-09 in UTC: this is the time zone trap.)
  { id: 1001, status: "processing", gmt: "2026-10-09T19:00:00", total: "30.00", first: "Asha", last: "Rao", items: [{ name: "Coffee Mug", quantity: 2, total: "25.00" }, { name: "Sticker Pack", quantity: 1, total: "5.00" }] },
  // 2026-10-09 15:30 in Kolkata -> yesterday (but "today" if you wrongly used UTC).
  { id: 1002, status: "completed", gmt: "2026-10-09T10:00:00", total: "12.50", first: "Ben", last: "Ito" },
  // 2026-10-07 10:30 in Kolkata -> inside the last 7 days only.
  { id: 1003, status: "cancelled", gmt: "2026-10-07T05:00:00", total: "19.99" },
  // 2026-09-20 -> outside everything.
  { id: 1004, status: "completed", gmt: "2026-09-20T05:00:00", total: "50.00" },
];
