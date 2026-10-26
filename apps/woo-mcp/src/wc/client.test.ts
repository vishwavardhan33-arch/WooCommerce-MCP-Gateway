import { describe, expect, it } from "vitest";
import { createFakeWc } from "../test/fakeWc.js";
import { WcApiError, WcClient } from "./client.js";

const make = (fetchImpl: typeof fetch, timeoutMs = 2000) =>
  new WcClient({ baseUrl: "http://store.test/", username: "mcp-bot", appPassword: "app-pass-123", timeoutMs, fetchImpl });

async function errorOf(p: Promise<unknown>): Promise<WcApiError> {
  try {
    await p;
  } catch (e) {
    return e as WcApiError;
  }
  throw new Error("expected the call to fail");
}

describe("WcClient", () => {
  it("authenticates with the app password and claims HTTPS so WordPress accepts it", async () => {
    const fake = createFakeWc();
    const wc = make(fake.fetchImpl);
    // The fake store answers 401 unless BOTH the Basic header and X-Forwarded-Proto: https are present.
    const products = await wc.get<unknown[]>("/wc/v3/products");
    expect(products).toEqual([]);
  });

  it("builds URLs under /wp-json and drops undefined query values", async () => {
    const fake = createFakeWc();
    await make(fake.fetchImpl).get("/wc/v3/products", { search: undefined, per_page: 5 });
    const call = fake.calls[0]!;
    expect(call.path).toBe("/wp-json/wc/v3/products");
    expect(call.query).toEqual({ per_page: "5" });
  });

  it("turns a WooCommerce error body into a WcApiError with status and code", async () => {
    const fake = createFakeWc();
    const err = await errorOf(make(fake.fetchImpl).get("/wc/v3/orders/999"));
    expect(err.status).toBe(404);
    expect(err.code).toBe("woocommerce_rest_shop_order_invalid_id");
  });

  it("reports wrong credentials as 401", async () => {
    const fake = createFakeWc({ password: "different" });
    const err = await errorOf(make(fake.fetchImpl).get("/wc/v3/products"));
    expect(err.status).toBe(401);
  });

  it("reports a timeout with code 'timeout'", async () => {
    const hang: typeof fetch = () => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    const err = await errorOf(make(hang).get("/"));
    expect(err.status).toBe(0);
    expect(err.code).toBe("timeout");
  });

  it("reports a refused connection as 'unreachable' and keeps the cause", async () => {
    const refused: typeof fetch = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    const err = await errorOf(make(refused).get("/"));
    expect(err.code).toBe("unreachable");
    expect(err.message).toContain("ECONNREFUSED");
  });

  it("rejects a 200 answer that is not JSON", async () => {
    const html: typeof fetch = async () => new Response("<html>home page</html>", { status: 200 });
    const err = await errorOf(make(html).get("/wc/v3/products"));
    expect(err.code).toBe("invalid_response");
  });
});
