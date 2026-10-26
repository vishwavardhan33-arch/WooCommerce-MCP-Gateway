import { FxError, round, type RateResult, type RateSource } from "./types.js";

// FX_MODE=static: a tiny built-in table so the server works with no internet and answers the
// same way every time. The numbers are plausible, NOT real market data.
// Each value is "how many of this currency one euro buys". Any pair is derived from two entries
// (a cross rate), so adding a currency is one line.
export const STATIC_EUR_RATES: Record<string, number> = {
  EUR: 1,
  USD: 1.08,
  GBP: 0.85,
  JPY: 162.5,
  INR: 90.2,
  CHF: 0.96,
  AUD: 1.65,
  CAD: 1.47,
  CNY: 7.85,
};
export const STATIC_DATE = "2026-01-02";

export class StaticRates implements RateSource {
  async rate(from: string, to: string): Promise<RateResult> {
    const fromPerEur = STATIC_EUR_RATES[from];
    const toPerEur = STATIC_EUR_RATES[to];
    for (const [code, value] of [[from, fromPerEur], [to, toPerEur]] as const) {
      if (value === undefined) {
        throw new FxError(
          "unknown_currency",
          `The currency "${code}" is not in the built-in offline table. Supported: ${Object.keys(STATIC_EUR_RATES).join(", ")}.`,
        );
      }
    }
    // 1 FROM = (1 / fromPerEur) EUR = (toPerEur / fromPerEur) TO.
    // The requested date is ignored: the table has one fixed date, reported back as `date`.
    return { from, to, rate: round((toPerEur as number) / (fromPerEur as number), 6), date: STATIC_DATE, source: "static" };
  }

  describe() {
    return { mode: "static" as const, detail: `built-in offline table (${Object.keys(STATIC_EUR_RATES).length} currencies), not real market data` };
  }
}
