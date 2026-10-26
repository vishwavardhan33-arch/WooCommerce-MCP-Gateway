import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { StaticRates } from "./fx/staticRates.js";
import { FxError, type RateSource } from "./fx/types.js";
import { createMcpServer } from "./server.js";

// The real MCP server and the real MCP client over an in-memory pipe, so tool registration,
// argument validation and result shapes are all exercised. Rates come from the offline table.
type Json = Record<string, unknown>;

async function setup(rates: RateSource = new StaticRates()) {
  const server = createMcpServer({ rates, logger: pino({ level: "silent" }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  async function call(name: string, args: Json = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    return { isError: res.isError === true, text, data: (res.isError ? {} : JSON.parse(text)) as Json };
  }
  // Invalid arguments may surface as an isError result or as a protocol-level InvalidParams error,
  // depending on the SDK version; either way the call must NOT succeed.
  async function isRejected(name: string, args: Json): Promise<boolean> {
    try {
      return (await client.callTool({ name, arguments: args })).isError === true;
    } catch {
      return true;
    }
  }
  return { client, call, isRejected };
}

describe("tool list", () => {
  it("exposes get_rate, convert and server_info, all read-only", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["convert", "get_rate", "server_info"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });
});

describe("get_rate", () => {
  it("returns the rate, its day and its source", async () => {
    const { call } = await setup();
    const { data } = await call("get_rate", { from: "USD", to: "EUR" });
    expect(data).toMatchObject({ from: "USD", to: "EUR", rate: 0.925926, source: "static" });
    expect(typeof data.date).toBe("string");
  });

  it("accepts lower-case and padded codes and reports them upper-case", async () => {
    const { call } = await setup();
    const { data } = await call("get_rate", { from: " usd ", to: "eur" });
    expect(data).toMatchObject({ from: "USD", to: "EUR" });
  });

  it("a currency against itself is 1", async () => {
    const { call } = await setup();
    expect((await call("get_rate", { from: "GBP", to: "GBP" })).data.rate).toBe(1);
  });

  it("answers an unsupported currency with a message that lists the supported ones", async () => {
    const { call } = await setup();
    const r = await call("get_rate", { from: "USD", to: "XYZ" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("XYZ");
    expect(r.text).toContain("Supported");
  });

  it("rejects malformed input before any rate is looked up", async () => {
    const { isRejected } = await setup();
    for (const bad of [{ from: "US", to: "EUR" }, { from: "USDX", to: "EUR" }, { from: "U$D", to: "EUR" }, { from: "USD" }, { from: "USD", to: "EUR", date: "2026-02-30" }, { from: "USD", to: "EUR", date: "yesterday" }]) {
      expect(await isRejected("get_rate", bad)).toBe(true);
    }
  });
});

describe("convert", () => {
  it("multiplies the amount by the rate and rounds to 4 decimals", async () => {
    const { call } = await setup();
    const { data } = await call("convert", { amount: 100, from: "USD", to: "INR" });
    expect(data).toMatchObject({ amount: 100, from: "USD", to: "INR", rate: 83.518519, result: 8351.8519, source: "static" });
  });

  it("converts zero, and a currency into itself", async () => {
    const { call } = await setup();
    expect((await call("convert", { amount: 0, from: "USD", to: "EUR" })).data.result).toBe(0);
    expect((await call("convert", { amount: 12.34, from: "CHF", to: "CHF" })).data.result).toBe(12.34);
  });

  it("rejects negative, absurd and non-numeric amounts", async () => {
    const { isRejected } = await setup();
    for (const amount of [-1, 1e13, "100", null]) {
      expect(await isRejected("convert", { amount, from: "USD", to: "EUR" })).toBe(true);
    }
  });
});

describe("failures from the rate source", () => {
  const failing = (kind: ConstructorParameters<typeof FxError>[0], message: string): RateSource => ({
    rate: async () => {
      throw new FxError(kind, message);
    },
    describe: () => ({ mode: "live", detail: "fake" }),
  });

  it("a timeout becomes an isError result that says to retry", async () => {
    const { call } = await setup(failing("timeout", "Frankfurter did not answer within 10000 ms."));
    const r = await call("convert", { amount: 1, from: "USD", to: "EUR" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/did not answer/);
    expect(r.text).toMatch(/Try again/);
  });

  it("an unreachable API suggests static mode", async () => {
    const { call } = await setup(failing("unreachable", "Frankfurter could not be reached: fetch failed"));
    expect((await call("get_rate", { from: "USD", to: "EUR" })).text).toContain("FX_MODE=static");
  });

  it("an unexpected bug is reported without crashing the server", async () => {
    const broken: RateSource = { rate: async () => { throw new Error("kaboom"); }, describe: () => ({ mode: "live", detail: "x" }) };
    const { call } = await setup(broken);
    const r = await call("get_rate", { from: "USD", to: "EUR" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("kaboom");
    expect((await call("server_info")).isError).toBe(false); // still serving
  });
});

describe("server_info", () => {
  it("reports name, version and rate source without calling out", async () => {
    const { call } = await setup();
    const { data } = await call("server_info");
    expect(data.server).toEqual({ name: "mcp-fx", version: "0.1.0" });
    expect((data.rates as Json).mode).toBe("static");
  });
});
