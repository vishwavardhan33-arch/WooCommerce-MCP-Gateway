import { describe, expect, it } from "vitest";
import { summarizeArgs, truncate } from "./redact.js";

describe("summarizeArgs", () => {
  it("records shapes, never string contents", () => {
    const summary = summarizeArgs({ search: "alice@example.com", limit: 20, include_drafts: true, ids: [1, 2, 3], filter: { a: 1 } });
    expect(summary).toEqual({ search: "string(17)", limit: 20, include_drafts: true, ids: "array(3)", filter: "object(1 keys)" });
    expect(JSON.stringify(summary)).not.toContain("alice");
  });

  it("redacts values whose NAME looks secret, whatever they are", () => {
    const summary = summarizeArgs({ password: "hunter2", apiKey: 12345, access_token: "t", Authorization: "Bearer x", sessionId: "s", note: "ok" });
    expect(summary.password).toBe("[redacted]");
    expect(summary.apiKey).toBe("[redacted]");
    expect(summary.access_token).toBe("[redacted]");
    expect(summary.Authorization).toBe("[redacted]");
    expect(summary.sessionId).toBe("[redacted]");
    expect(summary.note).toBe("string(2)");
  });

  it("copes with no arguments, null and undefined values", () => {
    expect(summarizeArgs(undefined)).toEqual({});
    expect(summarizeArgs({ a: null, b: undefined })).toEqual({ a: null, b: null });
  });

  it("bounds the size of the record", () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    const summary = summarizeArgs(many);
    expect(Object.keys(summary)).toHaveLength(21); // 20 arguments + the "..." marker
    expect(summary["..."]).toBe("30 more arguments");
    expect(Object.keys(summarizeArgs({ ["x".repeat(500)]: 1 }))[0]).toHaveLength(50);
  });
});

describe("truncate", () => {
  it("leaves short text alone and cuts long text", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("x".repeat(500), 300)).toBe(`${"x".repeat(300)}...`);
  });
});
