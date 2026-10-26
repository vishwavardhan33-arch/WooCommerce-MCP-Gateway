import { describe, expect, it } from "vitest";
import { runChat, type ChatEvent, type ToolRunner } from "./agent.js";
import type { LlmConfig } from "./llm.js";

const llm: LlmConfig = { baseUrl: "https://llm.test/v1", model: "m", apiKey: "k" };

// The model is scripted: each entry is what it "says" on that round (text and/or tool calls).
type Turn = { text?: string; calls?: { id: string; name: string; args: string }[]; rateLimited?: boolean };
function scriptedFetch(turns: Turn[]) {
  const requests: { messages: { role: string; content: unknown; tool_call_id?: string }[]; tools?: unknown[] }[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const turn = turns[requests.length - 1] ?? { text: "(script ended)" };
    if (turn.rateLimited) return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
    const lines: string[] = [];
    if (turn.text) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: turn.text } }] })}`);
    (turn.calls ?? []).forEach((c, index) =>
      lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: c.id, function: { name: c.name, arguments: c.args } }] } }] })}`),
    );
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: turn.calls?.length ? "tool_calls" : "stop" }] })}`, "data: [DONE]");
    return new Response(lines.join("\n") + "\n", { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function runner(handler: ToolRunner["call"] = async () => ({ text: "42 products", isError: false })) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const r: ToolRunner = {
    list: async () => [
      // What McpServer + zod really send: a $schema, additionalProperties, exclusiveMinimum, defaults...
      {
        name: "shop__list_products",
        description: "[shop] Lists products",
        inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { limit: { type: "integer", exclusiveMinimum: 0, default: 20 } }, additionalProperties: false },
      },
      { name: "shop__server_info", description: "[shop] Server info", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    ],
    call: async (name, args) => {
      calls.push({ name, args });
      return handler(name, args);
    },
  };
  return { runner: r, calls };
}

async function chat(turns: Turn[], r = runner(), maxSteps?: number) {
  const events: ChatEvent[] = [];
  const { fetchImpl, requests } = scriptedFetch(turns);
  await runChat({
    llm,
    runner: r.runner,
    history: [{ role: "user", content: "How many products?" }],
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    timeZone: "Asia/Kolkata",
    now: () => new Date("2026-10-14T10:30:00Z"),
    fetchImpl,
    maxSteps,
    retry: { sleep: async () => undefined, random: () => 1 },
  });
  return { events, requests, calls: r.calls };
}

describe("runChat", () => {
  it("answers directly when the model needs no tool", async () => {
    const { events, requests } = await chat([{ text: "Hello there" }]);
    expect(events).toEqual([{ type: "text", delta: "Hello there" }, { type: "done" }]);
    expect(requests).toHaveLength(1);
  });

  it("offers the tools in the OpenAI function format with schemas a strict API accepts", async () => {
    const { requests } = await chat([{ text: "ok" }]);
    const tools = requests[0]?.tools as { function: { name: string; parameters?: unknown } }[];
    expect(tools[0]?.function.name).toBe("shop__list_products");
    expect(tools[0]?.function.parameters).toEqual({ type: "object", properties: { limit: { type: "integer", description: "(default: 20; range: 0 to ...)" } } });
    expect(JSON.stringify(tools)).not.toMatch(/\$schema|additionalProperties|exclusiveMinimum/);
    // A tool without arguments has no `parameters` at all (Gemini rejects an empty properties object).
    expect(tools[1]?.function.name).toBe("shop__server_info");
    expect("parameters" in (tools[1]?.function ?? {})).toBe(false);
  });

  it("starts with a system prompt that has the date in the person's time zone and warns about tool output", async () => {
    const { requests } = await chat([{ text: "ok" }]);
    const system = String(requests[0]?.messages[0]?.content);
    expect(requests[0]?.messages[0]?.role).toBe("system");
    expect(system).toContain("14 October 2026");
    expect(system).toContain("16:00");
    expect(system).toContain("Asia/Kolkata");
    expect(system).toMatch(/untrusted/i);
    expect(requests[0]?.messages[1]).toEqual({ role: "user", content: "How many products?" });
  });

  it("emits retry events while the model API rate-limits, then carries on", async () => {
    const { events, requests } = await chat([{ rateLimited: true }, { rateLimited: true }, { text: "Hello" }]);
    expect(events.map((e) => e.type)).toEqual(["retry", "retry", "text", "done"]);
    expect(events[0]).toEqual({ type: "retry", attempt: 1, waitMs: 0 });
    expect(events[1]).toEqual({ type: "retry", attempt: 2, waitMs: 0 });
    expect(requests).toHaveLength(3);
  });

  it("runs a requested tool, shows the model its result, and streams the final answer", async () => {
    const { events, requests, calls } = await chat([
      { calls: [{ id: "c1", name: "shop__list_products", args: '{"limit":5}' }] },
      { text: "There are 42 products." },
    ]);
    expect(calls).toEqual([{ name: "shop__list_products", args: { limit: 5 } }]);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(events[0]).toEqual({ type: "tool_call", id: "c1", name: "shop__list_products", args: { limit: 5 } });
    expect(events[1]).toMatchObject({ type: "tool_result", id: "c1", name: "shop__list_products", isError: false, result: "42 products", truncated: false });
    expect(typeof (events[1] as { durationMs: number }).durationMs).toBe("number");

    // The second request carries the assistant's tool call and the tool's result, paired by id.
    const second = requests[1]?.messages ?? [];
    expect(second.at(-2)).toMatchObject({ role: "assistant" });
    expect(second.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "42 products" });
  });

  it("handles several tool calls in one round, in order", async () => {
    const { calls } = await chat([
      { calls: [{ id: "a", name: "shop__list_products", args: "{}" }, { id: "b", name: "shop__list_products", args: '{"limit":1}' }] },
      { text: "done" },
    ]);
    expect(calls.map((c) => c.args)).toEqual([{}, { limit: 1 }]);
  });

  it("reports a failing tool to the model as an error result instead of stopping", async () => {
    const { events, requests } = await chat(
      [{ calls: [{ id: "c1", name: "shop__list_products", args: "{}" }] }, { text: "Sorry, the store is down." }],
      runner(async () => ({ text: "Server unreachable", isError: true })),
    );
    expect(events[1]).toMatchObject({ type: "tool_result", isError: true, result: "Server unreachable" });
    expect(requests[1]?.messages.at(-1)?.content).toBe("Server unreachable");
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("turns a thrown tool error into an error result", async () => {
    const { events } = await chat(
      [{ calls: [{ id: "c1", name: "shop__list_products", args: "{}" }] }, { text: "ok" }],
      runner(async () => {
        throw new Error("pipe broke");
      }),
    );
    expect(events[1]).toMatchObject({ type: "tool_result", isError: true });
    expect((events[1] as { result: string }).result).toContain("pipe broke");
  });

  it("does not call a tool whose arguments are not valid JSON, and tells the model why", async () => {
    const r = runner();
    const { events, calls } = await chat([{ calls: [{ id: "c1", name: "shop__list_products", args: "{oops" }] }, { text: "retrying" }], r);
    expect(calls).toHaveLength(0);
    expect(events[1]).toMatchObject({ type: "tool_result", isError: true });
    expect((events[1] as { result: string }).result).toMatch(/not a valid JSON/);
  });

  it("truncates huge results for the UI and for the model", async () => {
    const { events, requests } = await chat(
      [{ calls: [{ id: "c1", name: "shop__list_products", args: "{}" }] }, { text: "ok" }],
      runner(async () => ({ text: "x".repeat(50_000), isError: false })),
    );
    expect((events[1] as { result: string }).result.length).toBeLessThan(2_100);
    expect((events[1] as { truncated: boolean }).truncated).toBe(true);
    expect(String(requests[1]?.messages.at(-1)?.content).length).toBeLessThan(16_100);
  });

  it("gives up after maxSteps rounds of tool calls", async () => {
    const loop: Turn = { calls: [{ id: "c", name: "shop__list_products", args: "{}" }] };
    const { events, requests } = await chat([loop, loop, loop, loop], runner(), 3);
    expect(requests).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect((events.at(-1) as { message: string }).message).toContain("3 rounds");
  });

  it("stops quietly when the client has gone", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: ChatEvent[] = [];
    const { fetchImpl, requests } = scriptedFetch([{ text: "never" }]);
    await runChat({ llm, runner: runner().runner, history: [{ role: "user", content: "x" }], emit: (e) => events.push(e), signal: controller.signal, timeZone: "UTC", fetchImpl });
    expect(events).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});
