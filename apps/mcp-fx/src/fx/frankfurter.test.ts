import { describe, expect, it } from "vitest";
import { FrankfurterRates } from "./frankfurter.js";
import { FxError } from "./types.js";

// The network is a fake fetch that records what was requested and answers as told.
function setup(answer: () => Response | Promise<Response>, baseUrl = "https://fx.test/v1", timeoutMs = 1000) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return answer();
  }) as typeof fetch;
  const rates = new FrankfurterRates({ baseUrl, timeoutMs, fetchImpl, now: () => new Date("2026-10-09T12:00:00Z") });
  return { rates, urls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const kindOf = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as FxError).kind;

describe("FrankfurterRates", () => {
  it("asks for the latest rate and returns the rate with the date the API reports", async () => {
    const { rates, urls } = setup(() => json({ amount: 1, base: "USD", date: "2026-10-08", rates: { EUR: 0.9234567891 } }));
    expect(await rates.rate("USD", "EUR")).toEqual({ from: "USD", to: "EUR", rate: 0.923457, date: "2026-10-08", source: "frankfurter" });
    expect(urls).toEqual(["https://fx.test/v1/latest?base=USD&symbols=EUR"]);
  });

  it("asks for a historical day when a date is given, and tolerates a trailing slash in the base URL", async () => {
    const { rates, urls } = setup(() => json({ date: "2024-01-02", rates: { GBP: 0.79 } }), "https://fx.test/v1/");
    await rates.rate("USD", "GBP", "2024-01-02");
    expect(urls).toEqual(["https://fx.test/v1/2024-01-02?base=USD&symbols=GBP"]);
  });

  it("does not call the API for a currency against itself", async () => {
    const { rates, urls } = setup(() => json({}));
    expect(await rates.rate("EUR", "EUR")).toMatchObject({ rate: 1, date: "2026-10-09" });
    expect(await rates.rate("EUR", "EUR", "2024-01-02")).toMatchObject({ rate: 1, date: "2024-01-02" });
    expect(urls).toHaveLength(0);
  });

  it("maps 404 to unknown_currency, 422 to invalid_request and other statuses to upstream", async () => {
    expect(await kindOf(setup(() => json({ message: "not found" }, 404)).rates.rate("USD", "XXX"))).toBe("unknown_currency");
    expect(await kindOf(setup(() => json({}, 422)).rates.rate("USD", "EUR"))).toBe("invalid_request");
    expect(await kindOf(setup(() => json({}, 503)).rates.rate("USD", "EUR"))).toBe("upstream");
  });

  it("maps a network failure to unreachable", async () => {
    const { rates } = setup(() => Promise.reject(new TypeError("fetch failed")));
    expect(await kindOf(rates.rate("USD", "EUR"))).toBe("unreachable");
  });

  it("really gives up after timeoutMs when the API hangs", async () => {
    const hang = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
    const rates = new FrankfurterRates({ baseUrl: "https://fx.test/v1", timeoutMs: 60, fetchImpl: hang });
    const started = Date.now();
    expect(await kindOf(rates.rate("USD", "EUR"))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("treats an answer that is not JSON, or has no usable rate, as bad_response", async () => {
    expect(await kindOf(setup(() => new Response("<html>oops</html>", { status: 200 })).rates.rate("USD", "EUR"))).toBe("bad_response");
    expect(await kindOf(setup(() => json({ date: "2026-10-08", rates: {} })).rates.rate("USD", "EUR"))).toBe("bad_response");
    expect(await kindOf(setup(() => json({ date: "2026-10-08", rates: { EUR: "0.9" } })).rates.rate("USD", "EUR"))).toBe("bad_response");
    expect(await kindOf(setup(() => json({ date: "2026-10-08", rates: { EUR: -1 } })).rates.rate("USD", "EUR"))).toBe("bad_response");
    expect(await kindOf(setup(() => json({ rates: { EUR: 0.9 } })).rates.rate("USD", "EUR"))).toBe("bad_response");
  });

  it("describes itself without any network", () => {
    const described = setup(() => json({})).rates.describe();
    expect(described.mode).toBe("live");
    expect(described.detail).toContain("fx.test");
  });
});
