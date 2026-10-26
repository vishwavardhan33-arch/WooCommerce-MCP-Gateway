import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const valid = { MCP_AUTH_TOKEN: "0123456789abcdef0123" };

describe("loadConfig", () => {
  it("applies defaults: live mode against the public Frankfurter API", () => {
    const c = loadConfig(valid);
    expect(c.PORT).toBe(3000);
    expect(c.FX_MODE).toBe("live");
    expect(c.FRANKFURTER_BASE_URL).toBe("https://api.frankfurter.dev/v1");
    expect(c.FX_TIMEOUT_MS).toBe(10000);
  });

  it("accepts static mode", () => {
    expect(loadConfig({ ...valid, FX_MODE: "static" }).FX_MODE).toBe("static");
  });

  it("rejects an unknown mode", () => {
    expect(() => loadConfig({ ...valid, FX_MODE: "offline" })).toThrow(/FX_MODE/);
  });

  it("requires a token of at least 16 characters, and never prints it", () => {
    expect(() => loadConfig({})).toThrow(/MCP_AUTH_TOKEN/);
    let message = "";
    try {
      loadConfig({ MCP_AUTH_TOKEN: "short" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("MCP_AUTH_TOKEN");
    expect(message).not.toContain("short");
  });
});
