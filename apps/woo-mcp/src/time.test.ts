import { describe, expect, it } from "vitest";
import { formatLocal, ianaTimezone, parseWcGmt, periodWindow, timezoneFromIndex } from "./time.js";

const iso = (ms: number) => new Date(ms).toISOString();

describe("periodWindow", () => {
  const kolkata = ianaTimezone("Asia/Kolkata"); // UTC+5:30, no daylight saving
  // 2026-10-10 01:30 in Kolkata, but still 2026-10-09 in UTC.
  const now = new Date("2026-10-09T20:00:00Z");

  it("today starts at the store's midnight, not UTC midnight", () => {
    const w = periodWindow("today", now, kolkata);
    expect(iso(w.startMs)).toBe("2026-10-09T18:30:00.000Z");
    expect(iso(w.endMs)).toBe("2026-10-10T18:30:00.000Z");
  });

  it("yesterday is the local day before", () => {
    const w = periodWindow("yesterday", now, kolkata);
    expect(iso(w.startMs)).toBe("2026-10-08T18:30:00.000Z");
    expect(iso(w.endMs)).toBe("2026-10-09T18:30:00.000Z");
  });

  it("last_7_days is today plus the 6 days before it", () => {
    const w = periodWindow("last_7_days", now, kolkata);
    expect(iso(w.startMs)).toBe("2026-10-03T18:30:00.000Z");
    expect(iso(w.endMs)).toBe("2026-10-10T18:30:00.000Z");
  });

  it("handles the 25-hour day when daylight saving ends (New York, 2026-11-01)", () => {
    const ny = ianaTimezone("America/New_York");
    const w = periodWindow("today", new Date("2026-11-01T12:00:00Z"), ny);
    expect(iso(w.startMs)).toBe("2026-11-01T04:00:00.000Z"); // midnight EDT (UTC-4)
    expect(iso(w.endMs)).toBe("2026-11-02T05:00:00.000Z"); // midnight EST (UTC-5)
  });

  it("rolls over month and year boundaries", () => {
    const utc = timezoneFromIndex({});
    const w = periodWindow("last_7_days", new Date("2027-01-03T10:00:00Z"), utc);
    expect(iso(w.startMs)).toBe("2026-12-28T00:00:00.000Z");
    expect(iso(w.endMs)).toBe("2027-01-04T00:00:00.000Z");
  });
});

describe("timezoneFromIndex", () => {
  it("prefers the named zone", () => {
    expect(timezoneFromIndex({ timezone_string: "Asia/Kolkata", gmt_offset: "0" }).label).toBe("Asia/Kolkata");
  });
  it("uses the numeric offset when no name is set", () => {
    const tz = timezoneFromIndex({ timezone_string: "", gmt_offset: "5.5" });
    expect(tz.label).toBe("UTC+05:30");
    expect(tz.offsetMinutesAt(0)).toBe(330);
  });
  it("handles negative offsets", () => {
    expect(timezoneFromIndex({ gmt_offset: -3.5 }).label).toBe("UTC-03:30");
  });
  it("falls back to the offset when the name is unknown", () => {
    expect(timezoneFromIndex({ timezone_string: "Mars/Olympus", gmt_offset: "2" }).label).toBe("UTC+02:00");
  });
  it("falls back to UTC when nothing is usable", () => {
    expect(timezoneFromIndex({}).label).toBe("UTC");
  });
});

describe("helpers", () => {
  it("parses WooCommerce GMT timestamps as UTC", () => {
    expect(iso(parseWcGmt("2026-10-09T19:00:00"))).toBe("2026-10-09T19:00:00.000Z");
    expect(iso(parseWcGmt("2026-10-09T19:00:00Z"))).toBe("2026-10-09T19:00:00.000Z");
    expect(Number.isNaN(parseWcGmt(""))).toBe(true);
  });
  it("formats a UTC instant in the store zone", () => {
    const tz = ianaTimezone("Asia/Kolkata");
    expect(formatLocal(Date.parse("2026-10-09T19:00:00Z"), tz)).toBe("2026-10-10 00:30");
  });
});
