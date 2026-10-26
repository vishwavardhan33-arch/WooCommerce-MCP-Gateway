import { describe, expect, it } from "vitest";
import { isRealDate } from "./dates.js";

describe("isRealDate", () => {
  it("accepts real days, including a leap day", () => {
    expect(isRealDate("2026-10-09")).toBe(true);
    expect(isRealDate("2024-02-29")).toBe(true);
  });
  it("rejects days that do not exist even though they look right", () => {
    expect(isRealDate("2026-02-30")).toBe(false);
    expect(isRealDate("2025-02-29")).toBe(false);
    expect(isRealDate("2026-13-01")).toBe(false);
  });
  it("rejects other shapes", () => {
    for (const bad of ["", "tomorrow", "2026-1-5", "10/09/2026", "2026-10-09T00:00:00Z"]) expect(isRealDate(bad)).toBe(false);
  });
});
