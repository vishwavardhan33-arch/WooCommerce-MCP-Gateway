import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const valid = {
  DATABASE_URL: "postgres://gateway:pw@db:5432/gateway",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  ADMIN_BOOTSTRAP_EMAIL: "Admin@Example.com",
  ADMIN_BOOTSTRAP_PASSWORD: "a-long-bootstrap-password",
  PUBLIC_BASE_URL: "http://app.localtest.me",
  CREDENTIAL_ENC_KEY: "0123456789abcdef".repeat(4),
};

describe("loadConfig", () => {
  it("applies defaults, with secure cookies on", () => {
    const c = loadConfig(valid);
    expect(c.PORT).toBe(3000);
    expect(c.COOKIE_SECURE).toBe(true);
    expect(c.SESSION_TTL_HOURS).toBe(24);
    expect(c.INVITE_TTL_HOURS).toBe(72);
  });

  it("parses the upstream host allowlist: trimmed, lower-cased, empty entries dropped", () => {
    expect(loadConfig(valid).UPSTREAM_ALLOWED_HOSTS).toEqual([]);
    const c = loadConfig({ ...valid, UPSTREAM_ALLOWED_HOSTS: " Platform-Woo-MCP , *.svc.cluster.local ,," });
    expect(c.UPSTREAM_ALLOWED_HOSTS).toEqual(["platform-woo-mcp", "*.svc.cluster.local"]);
  });

  it("requires a 64-hex-character credential key", () => {
    expect(() => loadConfig({ ...valid, CREDENTIAL_ENC_KEY: "too-short" })).toThrow(/CREDENTIAL_ENC_KEY/);
  });

  it("normalises the admin email to lower case", () => {
    expect(loadConfig(valid).ADMIN_BOOTSTRAP_EMAIL).toBe("admin@example.com");
  });

  it('reads COOKIE_SECURE="false" as false (not as a non-empty, truthy string)', () => {
    expect(loadConfig({ ...valid, COOKIE_SECURE: "false" }).COOKIE_SECURE).toBe(false);
  });

  it("names every bad variable and never prints a value", () => {
    let message = "";
    try {
      loadConfig({ SESSION_SECRET: "too-short-secret", ADMIN_BOOTSTRAP_PASSWORD: "short-pw" });
    } catch (e) {
      message = (e as Error).message;
    }
    for (const name of ["DATABASE_URL", "SESSION_SECRET", "ADMIN_BOOTSTRAP_EMAIL", "ADMIN_BOOTSTRAP_PASSWORD", "PUBLIC_BASE_URL", "CREDENTIAL_ENC_KEY"]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain("too-short-secret");
    expect(message).not.toContain("short-pw");
  });
});
