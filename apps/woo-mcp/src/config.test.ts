import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const valid = {
  MCP_AUTH_TOKEN: "0123456789abcdef0123",
  WC_BASE_URL: "http://platform-store-wordpress",
  WC_USERNAME: "mcp-bot",
  WC_APP_PASSWORD: "super-secret-app-password",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(valid);
    expect(c.PORT).toBe(3000);
    expect(c.LOG_LEVEL).toBe("info");
    expect(c.WC_TIMEOUT_MS).toBe(15000);
  });

  it("coerces numbers from strings", () => {
    expect(loadConfig({ ...valid, PORT: "8080", WC_TIMEOUT_MS: "5000" }).PORT).toBe(8080);
  });

  it("names every missing variable and never prints a value", () => {
    let message = "";
    try {
      loadConfig({ MCP_AUTH_TOKEN: "short-secret" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("WC_BASE_URL");
    expect(message).toContain("WC_USERNAME");
    expect(message).toContain("WC_APP_PASSWORD");
    expect(message).toContain("MCP_AUTH_TOKEN");
    expect(message).not.toContain("short-secret");
  });
});
