export interface RateResult {
  from: string;
  to: string;
  /** How many units of `to` one unit of `from` buys. */
  rate: number;
  /** The day the rate is for (YYYY-MM-DD). */
  date: string;
  source: "frankfurter" | "static";
}

/** Where rates come from. The tools only know this interface, so tests and offline mode just swap the source. */
export interface RateSource {
  rate(from: string, to: string, date?: string): Promise<RateResult>;
  /** What server_info reports about this source. Must not make a network call. */
  describe(): { mode: "live" | "static"; detail: string };
}

// The ways getting a rate can fail, kept few so each one gets a clear message in tools/result.ts.
export type FxErrorKind = "unknown_currency" | "invalid_request" | "timeout" | "unreachable" | "upstream" | "bad_response";

export class FxError extends Error {
  constructor(
    public readonly kind: FxErrorKind,
    message: string,
  ) {
    super(message);
  }
}

// Six decimals is more precision than any real exchange rate has; rounding also hides float
// noise such as 0.30000000000000004.
export const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};
