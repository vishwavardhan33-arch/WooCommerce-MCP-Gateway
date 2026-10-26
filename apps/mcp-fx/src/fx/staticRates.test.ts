import { describe, expect, it } from "vitest";
import { STATIC_DATE, StaticRates } from "./staticRates.js";
import { FxError } from "./types.js";

const rates = new StaticRates();

describe("StaticRates", () => {
  it("derives a cross rate from the two euro rates", async () => {
    const r = await rates.rate("USD", "INR");
    expect(r).toEqual({ from: "USD", to: "INR", rate: 83.518519, date: STATIC_DATE, source: "static" }); // 90.2 / 1.08
  });

  it("is consistent in both directions", async () => {
    const there = (await rates.rate("GBP", "JPY")).rate;
    const back = (await rates.rate("JPY", "GBP")).rate;
    expect(there * back).toBeGreaterThan(0.9999);
    expect(there * back).toBeLessThan(1.0001);
  });

  it("a currency against itself is exactly 1", async () => {
    expect((await rates.rate("CHF", "CHF")).rate).toBe(1);
  });

  it("ignores a requested date and reports the fixed one", async () => {
    expect((await rates.rate("USD", "EUR", "2020-01-01")).date).toBe(STATIC_DATE);
  });

  it("names the unsupported currency and lists the supported ones", async () => {
    const err = await rates.rate("USD", "XYZ").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FxError);
    expect((err as FxError).kind).toBe("unknown_currency");
    expect((err as FxError).message).toContain("XYZ");
    expect((err as FxError).message).toContain("EUR");
  });

  it("describes itself without any network", () => {
    expect(rates.describe().mode).toBe("static");
  });
});
