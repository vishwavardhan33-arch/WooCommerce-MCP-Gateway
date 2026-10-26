import { describe, expect, it } from "vitest";
import { elapsedSince, formatDuration, formatPercent, relativeTime, splitToolName } from "./format.js";

const NOW = new Date("2026-10-12T12:00:00Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("relativeTime", () => {
  it("says never for null", () => expect(relativeTime(null, NOW)).toBe("never"));
  it("picks the right unit", () => {
    expect(relativeTime(ago(3_000), NOW)).toBe("just now");
    expect(relativeTime(ago(42_000), NOW)).toBe("42s ago");
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5 min ago");
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe("3 h ago");
    expect(relativeTime(ago(2 * 86_400_000), NOW)).toBe("2 d ago");
  });
  it("copes with a timestamp slightly in the future and with garbage", () => {
    expect(relativeTime(new Date(NOW + 5000).toISOString(), NOW)).toBe("just now");
    expect(relativeTime("not a date", NOW)).toBe("unknown");
  });
});

describe("elapsedSince", () => {
  it("reads as a duration, without 'ago'", () => {
    expect(elapsedSince(ago(2_000), NOW)).toBe("a few seconds");
    expect(elapsedSince(ago(42_000), NOW)).toBe("42s");
    expect(elapsedSince(ago(5 * 60_000), NOW)).toBe("5 min");
    expect(elapsedSince(ago(3 * 3_600_000), NOW)).toBe("3 h");
    expect(elapsedSince(ago(2 * 86_400_000), NOW)).toBe("2 d");
    expect(elapsedSince("garbage", NOW)).toBe("an unknown time");
  });
});

describe("formatDuration", () => {
  it("uses ms below a second and seconds above", () => {
    expect(formatDuration(42)).toBe("42 ms");
    expect(formatDuration(999.6)).toBe("1000 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(12_000)).toBe("12 s");
  });
});

describe("formatPercent", () => {
  it("handles zero totals and small fractions", () => {
    expect(formatPercent(0, 0)).toBe("0%");
    expect(formatPercent(1, 200)).toBe("0.5%");
    expect(formatPercent(1, 4)).toBe("25%");
    expect(formatPercent(0, 10)).toBe("0%");
  });
});

describe("splitToolName", () => {
  it("splits at the first double underscore only", () => {
    expect(splitToolName("shop__list_products")).toEqual({ server: "shop", tool: "list_products" });
    expect(splitToolName("shop__a__b")).toEqual({ server: "shop", tool: "a__b" });
    expect(splitToolName("plain")).toEqual({ server: null, tool: "plain" });
  });
});
