import { FxError, round, type RateResult, type RateSource } from "./types.js";

export interface FrankfurterOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Replaceable in tests so they need no network. */
  fetchImpl?: typeof fetch;
  /** "Today" for same-currency answers; replaceable in tests. */
  now?: () => Date;
}

// Frankfurter publishes the European Central Bank's reference rates (free, no API key).
//   GET {base}/latest?base=USD&symbols=EUR      -> { "amount": 1, "base": "USD", "date": "2026-10-09", "rates": { "EUR": 0.92 } }
//   GET {base}/2024-01-02?base=USD&symbols=EUR  -> the same for a past day
// Rates exist only for ECB working days; for a weekend the API answers with the previous working day,
// which is why we report the `date` the API returns, not the one that was asked for.
export class FrankfurterRates implements RateSource {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: FrankfurterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, ""); // so "…/v1/" and "…/v1" behave the same
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  async rate(from: string, to: string, date?: string): Promise<RateResult> {
    // Converting a currency to itself needs no network call: the rate is exactly 1.
    if (from === to) return { from, to, rate: 1, date: date ?? this.now().toISOString().slice(0, 10), source: "frankfurter" };

    const url = `${this.baseUrl}/${date ?? "latest"}?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
    let response: Response;
    try {
      // AbortSignal.timeout cancels the request after timeoutMs, so a hung API cannot hang the caller.
      response = await this.fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new FxError("timeout", `Frankfurter did not answer within ${this.opts.timeoutMs} ms.`);
      }
      throw new FxError("unreachable", `Frankfurter could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      // 404 = unknown currency, or no data for that date. 422 = a request Frankfurter considers invalid.
      if (response.status === 404) {
        throw new FxError("unknown_currency", `Frankfurter has no rate for ${from} -> ${to}${date ? ` on ${date}` : ""}: unknown currency code, or no data for that date.`);
      }
      if (response.status === 422) throw new FxError("invalid_request", `Frankfurter rejected the request for ${from} -> ${to}.`);
      throw new FxError("upstream", `Frankfurter returned an error (HTTP ${response.status}).`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FxError("bad_response", "Frankfurter answered with something that is not JSON.");
    }
    // Trust nothing about the shape: check exactly what we use.
    const data = body as { date?: unknown; rates?: Record<string, unknown> };
    const rate = data.rates?.[to];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || typeof data.date !== "string") {
      throw new FxError("bad_response", `Frankfurter's answer did not contain a usable rate for ${from} -> ${to}.`);
    }
    return { from, to, rate: round(rate, 6), date: data.date, source: "frankfurter" };
  }

  describe() {
    return { mode: "live" as const, detail: `Frankfurter (${this.baseUrl}), European Central Bank reference rates` };
  }
}
