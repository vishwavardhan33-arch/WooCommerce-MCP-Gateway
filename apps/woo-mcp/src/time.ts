// "Today" means today in the STORE's time zone: not the server's (UTC inside a container) and not
// the caller's. A shop in India asked "what came in today?" at 00:30 local time must not get
// yesterday's orders just because UTC has not rolled over yet.

export const PERIODS = ["today", "yesterday", "last_7_days"] as const;
export type Period = (typeof PERIODS)[number];

export interface StoreTimezone {
  /** Shown to the model, e.g. "Asia/Kolkata" or "UTC+05:30". */
  label: string;
  /** UTC offset in minutes in effect at the given instant (so daylight saving is handled). */
  offsetMinutesAt(utcMs: number): number;
}

/** A named zone from the tz database. Throws RangeError if the name is unknown. */
export function ianaTimezone(name: string): StoreTimezone {
  // hourCycle "h23" matters: hour12:false can print "24" at midnight.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: name,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  return {
    label: name,
    offsetMinutesAt(utcMs) {
      // Drop the milliseconds so the difference below is a whole number of minutes.
      const whole = utcMs - (((utcMs % 1000) + 1000) % 1000);
      const parts = fmt.formatToParts(new Date(whole));
      const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
      // Read the wall-clock time in the zone as if it were UTC; the gap to the real instant is the offset.
      const wallClockAsUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
      return Math.round((wallClockAsUtc - whole) / 60_000);
    },
  };
}

/** A zone with a constant offset, for stores that only set "UTC+5:30" in WordPress. */
export function fixedOffsetTimezone(minutes: number): StoreTimezone {
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return {
    label: minutes === 0 ? "UTC" : `UTC${minutes < 0 ? "-" : "+"}${hh}:${mm}`,
    offsetMinutesAt: () => minutes,
  };
}

/**
 * Build the store zone from the two values the WordPress REST index publishes:
 * timezone_string (a name, may be empty) and gmt_offset (hours, may be "5.5").
 * Falls back to UTC when neither is usable, rather than failing every order query.
 */
export function timezoneFromIndex(index: { timezone_string?: string; gmt_offset?: string | number }): StoreTimezone {
  const name = index.timezone_string?.trim();
  if (name) {
    try {
      return ianaTimezone(name);
    } catch {
      // unknown name: try the numeric offset next
    }
  }
  if (index.gmt_offset !== undefined && index.gmt_offset !== "") {
    const hours = Number(index.gmt_offset);
    if (Number.isFinite(hours)) return fixedOffsetTimezone(Math.round(hours * 60));
  }
  return fixedOffsetTimezone(0);
}

function localDate(utcMs: number, tz: StoreTimezone) {
  const shifted = new Date(utcMs + tz.offsetMinutesAt(utcMs) * 60_000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

// The UTC instant at which the given calendar day begins in the zone. Date.UTC normalises
// day overflow (day 0 = last day of the previous month), so callers can add or subtract days.
// The offset is looked up twice because the offset at "midnight UTC" can differ from the
// offset at local midnight on a daylight-saving change day.
function startOfLocalDay(y: number, m: number, d: number, tz: StoreTimezone): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tz.offsetMinutesAt(guess) * 60_000;
  return guess - tz.offsetMinutesAt(first) * 60_000;
}

export interface Window {
  startMs: number; // inclusive
  endMs: number; // exclusive
}

/**
 * today        = from local midnight until the next local midnight
 * yesterday    = the previous local day
 * last_7_days  = today plus the 6 days before it (7 calendar days)
 */
export function periodWindow(period: Period, now: Date, tz: StoreTimezone): Window {
  const { y, m, d } = localDate(now.getTime(), tz);
  const day = (offset: number) => startOfLocalDay(y, m, d + offset, tz);
  switch (period) {
    case "today":
      return { startMs: day(0), endMs: day(1) };
    case "yesterday":
      return { startMs: day(-1), endMs: day(0) };
    case "last_7_days":
      return { startMs: day(-6), endMs: day(1) };
  }
}

/** "2026-10-10 00:30" in the store's zone: compact and unambiguous for a model to read. */
export function formatLocal(utcMs: number, tz: StoreTimezone): string {
  return new Date(utcMs + tz.offsetMinutesAt(utcMs) * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

/** WooCommerce's *_gmt fields are UTC but carry no "Z", so add it before parsing. */
export function parseWcGmt(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
}
