import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const valid = { MCP_AUTH_TOKEN: "0123456789abcdef0123" };

describe("loadConfig", () => {
  it("applies defaults: the database lives on the mounted volume", () => {
    const c = loadConfig(valid);
    expect(c.PORT).toBe(3000);
    expect(c.NOTES_DB_PATH).toBe("/data/notes.db");
  });

  it("takes the database path from the environment", () => {
    expect(loadConfig({ ...valid, NOTES_DB_PATH: "./notes.db" }).NOTES_DB_PATH).toBe("./notes.db");
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
