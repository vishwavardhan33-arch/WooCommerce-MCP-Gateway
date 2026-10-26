import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "./server.js";
import { createFakeWc, KOLKATA_ORDERS, type FakeOrderInput, type FakeWcOptions } from "./test/fakeWc.js";
import { WcClient } from "./wc/client.js";

// These tests talk to the real MCP server through the real MCP client over an in-memory pipe
// (so tool registration, argument validation and result shapes are exercised), while the store
// is the fake from test/fakeWc.ts. "Now" is fixed: 2026-10-09 20:00 UTC = 2026-10-10 01:30 in Kolkata.
const NOW = new Date("2026-10-09T20:00:00Z");
const KOLKATA: FakeWcOptions = { timezoneString: "Asia/Kolkata", orders: KOLKATA_ORDERS };

type Json = Record<string, unknown>;

async function setup(opts: FakeWcOptions = KOLKATA, appPassword?: string) {
  const fake = createFakeWc(opts);
  const wc = new WcClient({
    baseUrl: "http://store.test",
    username: fake.username,
    appPassword: appPassword ?? fake.password,
    timeoutMs: 2000,
    fetchImpl: fake.fetchImpl,
  });
  const server = createMcpServer({ wc, logger: pino({ level: "silent" }), now: () => NOW });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  async function call(name: string, args: Json = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    return { isError: res.isError === true, text, data: (res.isError ? {} : JSON.parse(text)) as Json };
  }
  // Invalid arguments may surface as an isError result or as a protocol-level InvalidParams error,
  // depending on the SDK version; either way the call must NOT succeed and must not reach the store.
  async function isRejected(name: string, args: Json): Promise<boolean> {
    try {
      const res = await client.callTool({ name, arguments: args });
      return res.isError === true;
    } catch {
      return true;
    }
  }
  return { client, fake, call, isRejected };
}

const ids = (data: Json) => (data.orders as { id: number }[]).map((o) => o.id);

describe("tool list", () => {
  it("exposes exactly the seven tools", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_product",
      "get_order",
      "get_sales_summary",
      "list_orders",
      "list_products",
      "server_info",
      "update_order_status",
    ]);
  });

  it("marks tools with honest annotations", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const hints = (name: string) => tools.find((t) => t.name === name)!.annotations!;
    for (const readOnly of ["list_products", "list_orders", "get_order", "get_sales_summary", "server_info"]) {
      expect(hints(readOnly).readOnlyHint).toBe(true);
    }
    expect(hints("create_product").readOnlyHint).toBe(false);
    expect(hints("create_product").destructiveHint).toBe(false);
    expect(hints("update_order_status").readOnlyHint).toBe(false);
    expect(hints("update_order_status").destructiveHint).toBe(true);
  });
});

describe("products", () => {
  it("creates a published product and returns its storefront URL", async () => {
    const { call, fake } = await setup();
    const r = await call("create_product", { name: "Test Hoodie", price: 49.5 });
    expect(r.isError).toBe(false);
    const created = r.data.created as Json;
    expect(created.name).toBe("Test Hoodie");
    expect(created.price).toBe("49.50");
    expect(created.status).toBe("publish");
    expect(created.url).toBe("http://shop.test/product/test-hoodie/");
    const post = fake.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ name: "Test Hoodie", type: "simple", regular_price: "49.50", status: "publish" });
  });

  it("returns trimmed products without WooCommerce noise", async () => {
    const { call } = await setup();
    await call("create_product", { name: "Coffee Mug", price: 12.5, sku: "MUG-1" });
    const r = await call("list_products", { search: "mug" });
    const product = (r.data.products as Json[])[0]!;
    expect(Object.keys(product).sort()).toEqual(["id", "name", "price", "sku", "status", "stock_status", "url"]);
    expect(r.text).not.toContain("meta_data");
    expect(r.text).not.toContain("_links");
  });

  it("filters by search text", async () => {
    const { call } = await setup();
    await call("create_product", { name: "Coffee Mug", price: 12.5 });
    await call("create_product", { name: "Tote Bag", price: 15 });
    const r = await call("list_products", { search: "tote" });
    expect(r.data.count).toBe(1);
  });

  it("reports a duplicate SKU as an isError result with the store's reason", async () => {
    const { call } = await setup();
    await call("create_product", { name: "A", price: 1, sku: "DUP-1" });
    const r = await call("create_product", { name: "B", price: 2, sku: "DUP-1" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("SKU");
  });

  it("rejects invalid arguments without calling the store", async () => {
    const { isRejected, fake } = await setup();
    expect(await isRejected("create_product", { name: "Bad", price: -5 })).toBe(true);
    expect(await isRejected("create_product", { name: "", price: 5 })).toBe(true);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("list_orders and the store's time zone", () => {
  it("today = the store's today, even though UTC is still yesterday", async () => {
    const { call } = await setup();
    const r = await call("list_orders", { period: "today" });
    expect(ids(r.data)).toEqual([1001]);
    expect(r.data.timezone).toBe("Asia/Kolkata");
    expect(r.data.from).toBe("2026-10-10 00:00");
    expect(r.data.until).toBe("2026-10-11 00:00");
  });

  it("yesterday and last_7_days", async () => {
    const { call } = await setup();
    expect(ids((await call("list_orders", { period: "yesterday" })).data)).toEqual([1002]);
    expect(ids((await call("list_orders", { period: "last_7_days" })).data)).toEqual([1001, 1002, 1003]);
  });

  it("defaults to today", async () => {
    const { call } = await setup();
    expect(ids((await call("list_orders")).data)).toEqual([1001]);
  });

  it("filters by status and honours limit", async () => {
    const { call } = await setup();
    expect(ids((await call("list_orders", { period: "last_7_days", status: "completed" })).data)).toEqual([1002]);
    const limited = await call("list_orders", { period: "last_7_days", limit: 2 });
    expect(limited.data.matched).toBe(3);
    expect(limited.data.shown).toBe(2);
  });

  it("asks the store for a window one day wider than needed and filters exactly itself", async () => {
    const { call, fake } = await setup();
    await call("list_orders", { period: "today" });
    const query = fake.calls.find((c) => c.path === "/wp-json/wc/v3/orders")!.query;
    expect(query.after).toBe("2026-10-08T18:30:00");
    expect(query.before).toBe("2026-10-11T18:30:00");
  });

  it("returns readable orders with the customer's name but no contact details", async () => {
    const { call } = await setup();
    const r = await call("list_orders", { period: "today" });
    const order = (r.data.orders as Json[])[0]!;
    expect(order.customer).toBe("Asha Rao");
    expect(order.placed_at).toBe("2026-10-10 00:30");
    expect(order.items).toEqual(["2 x Coffee Mug", "1 x Sticker Pack"]);
    expect(r.text).not.toContain("private@example.com");
    expect(r.text).not.toContain("Secret Street");
    expect(r.text).not.toContain("555-0100");
  });

  it("reads several pages of orders", async () => {
    const many: FakeOrderInput[] = Array.from({ length: 150 }, (_, i) => ({ id: 2000 + i, status: "processing", gmt: "2026-10-09T19:00:00", total: "1.00" }));
    const { call } = await setup({ timezoneString: "Asia/Kolkata", orders: many });
    const r = await call("list_orders", { period: "today", limit: 50 });
    expect(r.data.matched).toBe(150);
    expect(r.data.shown).toBe(50);
    expect(r.data.warning).toBeUndefined();
  });

  it("says so when it stops at the page cap", async () => {
    const many: FakeOrderInput[] = Array.from({ length: 520 }, (_, i) => ({ id: 3000 + i, status: "processing", gmt: "2026-10-09T19:00:00", total: "1.00" }));
    const { call } = await setup({ timezoneString: "Asia/Kolkata", orders: many });
    const r = await call("get_sales_summary", { period: "today" });
    expect(r.data.warning).toBeDefined();
    expect(r.data.orders_total).toBe(500);
  });
});

describe("get_order and update_order_status", () => {
  it("returns one order with line items", async () => {
    const { call } = await setup();
    const r = await call("get_order", { id: 1001 });
    expect(r.data.customer).toBe("Asha Rao");
    expect(r.data.payment_method).toBe("Cash on delivery");
    expect(r.data.line_items).toHaveLength(2);
    expect(r.text).not.toContain("private@example.com");
  });

  it("explains a missing order", async () => {
    const { call } = await setup();
    const r = await call("get_order", { id: 999 });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Order 999 was not found.");
  });

  it("updates the status", async () => {
    const { call, fake } = await setup();
    const r = await call("update_order_status", { id: 1001, status: "completed" });
    expect((r.data.updated as Json).status).toBe("completed");
    const put = fake.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/wp-json/wc/v3/orders/1001");
    expect(put.body).toEqual({ status: "completed" });
  });

  it("explains an unknown order on update", async () => {
    const { call } = await setup();
    const r = await call("update_order_status", { id: 4040, status: "completed" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Order 4040 was not found.");
  });

  it("rejects a status that is not in the enum, without calling the store", async () => {
    const { isRejected, fake } = await setup();
    expect(await isRejected("update_order_status", { id: 1001, status: "teleported" })).toBe(true);
    expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });
});

describe("get_sales_summary", () => {
  it("summarises today", async () => {
    const { call } = await setup();
    const r = await call("get_sales_summary", { period: "today" });
    expect(r.data.orders_total).toBe(1);
    expect(r.data.revenue).toBe("30.00");
    expect(r.data.currency).toBe("USD");
    expect(r.data.by_status).toEqual({ processing: 1 });
  });

  it("counts revenue only for processing, completed and on-hold orders", async () => {
    const { call } = await setup();
    const r = await call("get_sales_summary", { period: "last_7_days" });
    expect(r.data.orders_total).toBe(3);
    expect(r.data.orders_counted_as_revenue).toBe(2);
    expect(r.data.revenue).toBe("42.50"); // 30.00 + 12.50; the cancelled 19.99 is excluded
    expect(r.data.by_status).toEqual({ processing: 1, completed: 1, cancelled: 1 });
  });

  it("handles a quiet day", async () => {
    const { call } = await setup({ timezoneString: "UTC", orders: [] });
    const r = await call("get_sales_summary", { period: "today" });
    expect(r.data.revenue).toBe("0.00");
    expect(r.data.currency).toBeNull();
  });
});

describe("server_info", () => {
  it("describes the server and the store", async () => {
    const { call } = await setup();
    const r = await call("server_info");
    expect((r.data.server as Json).name).toBe("woo-mcp");
    expect((r.data.store as Json).name).toBe("Demo Shop");
    expect((r.data.store as Json).timezone).toBe("Asia/Kolkata");
  });
});

describe("failures become isError results", () => {
  it("store unreachable", async () => {
    const { call } = await setup({ networkError: "connect ECONNREFUSED 10.0.0.1:80" });
    const r = await call("list_products");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("could not be reached");
  });

  it("wrong credentials: a clear message that never contains the password", async () => {
    const { call } = await setup(KOLKATA, "wrong-secret-pw");
    const r = await call("list_products");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("credentials");
    expect(r.text).not.toContain("wrong-secret-pw");
  });

  it("store server error", async () => {
    const { call } = await setup({ ...KOLKATA, failAuthenticatedWith: 500 });
    const r = await call("list_orders");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 500");
  });
});
