import { describe, expect, it } from "vitest";
import { LlmError, MAX_RETRY_WAIT_MS, retryDelayMs, streamCompletion, type LlmConfig } from "./llm.js";

const llm: LlmConfig = { baseUrl: "https://llm.test/v1/", model: "test-model", apiKey: "sk-secret-key" };

// A fake streaming API: sends the given lines, split into awkward byte chunks on purpose.
function sse(lines: string[], chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(lines.join("\n") + "\n");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const data = (obj: unknown) => `data: ${JSON.stringify(obj)}`;
const delta = (d: object, finish: string | null = null) => data({ choices: [{ delta: d, finish_reason: finish }] });

function run(response: () => Response | Promise<Response>, extra: { tools?: never[]; signal?: AbortSignal } = {}) {
  const seen: { url: string; init: RequestInit }[] = [];
  const texts: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  const promise = streamCompletion({
    llm,
    messages: [{ role: "user", content: "hi" }],
    tools: extra.tools ?? [],
    signal: extra.signal ?? new AbortController().signal,
    onText: (t) => texts.push(t),
    fetchImpl,
  });
  return { promise, seen, texts };
}

describe("streamCompletion", () => {
  it("sends the request the API expects, with the key in the Authorization header only", async () => {
    const { promise, seen } = run(() => sse([delta({ content: "ok" }, "stop"), "data: [DONE]"]));
    await promise;
    expect(seen[0]?.url).toBe("https://llm.test/v1/chat/completions");
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-secret-key");
    const body = JSON.parse(String(seen[0]?.init.body));
    expect(body).toMatchObject({ model: "test-model", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(body.tools).toBeUndefined(); // no tools: the field is left out entirely
    expect(JSON.stringify(body)).not.toContain("sk-secret-key");
  });

  it("passes text to onText as it arrives, even when bytes split mid-line, and returns the whole text", async () => {
    const { promise, texts } = run(() => sse([delta({ content: "Hel" }), "", delta({ content: "lo wor" }), delta({ content: "ld" }, "stop"), "data: [DONE]"], 5));
    const result = await promise;
    expect(texts).toEqual(["Hel", "lo wor", "ld"]);
    expect(result).toEqual({ content: "Hello world", toolCalls: [], finishReason: "stop" });
  });

  it("glues a tool call's argument pieces together, per index, for several calls", async () => {
    const { promise } = run(() =>
      sse([
        delta({ tool_calls: [{ index: 0, id: "call_a", function: { name: "shop__list_products", arguments: "" } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"limit"' } }] }),
        delta({ tool_calls: [{ index: 1, id: "call_b", function: { name: "fx__convert", arguments: '{"amount":' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: ":3}" } }] }),
        delta({ tool_calls: [{ index: 1, function: { arguments: "100}" } }] }, "tool_calls"),
        "data: [DONE]",
      ]),
    );
    const result = await promise;
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call_a", type: "function", function: { name: "shop__list_products", arguments: '{"limit":3}' } },
      { id: "call_b", type: "function", function: { name: "fx__convert", arguments: '{"amount":100}' } },
    ]);
  });

  it("invents an id when the provider sends none, and skips malformed chunks and comments", async () => {
    const { promise } = run(() =>
      sse([": keep-alive", "data: {not json", delta({ tool_calls: [{ index: 0, function: { name: "notes__list_notes", arguments: "{}" } }] }, "tool_calls"), "data: [DONE]"]),
    );
    const { toolCalls } = await promise;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.id).toMatch(/^call_0_/);
  });

  it("turns an HTTP error into an LlmError that includes the provider's message but never our key", async () => {
    const { promise } = run(() => new Response('{"error":"model not found"}', { status: 404 }));
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as Error).message).toContain("HTTP 404");
    expect((err as Error).message).toContain("model not found");
    expect((err as Error).message).not.toContain("sk-secret-key");
  });

  it("turns a network failure into an LlmError, but lets a cancellation through as it is", async () => {
    const down = run(() => Promise.reject(new TypeError("fetch failed")));
    expect(await down.promise.catch((e: unknown) => e)).toBeInstanceOf(LlmError);

    const controller = new AbortController();
    controller.abort();
    const aborted = run(() => Promise.reject(new DOMException("aborted", "AbortError")), { signal: controller.signal });
    const err = await aborted.promise.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(LlmError);
  });
});

describe("retryDelayMs", () => {
  it("believes Retry-After in seconds or as a date", () => {
    expect(retryDelayMs("3", 0, () => 1)).toBe(3000);
    expect(retryDelayMs("0", 2, () => 1)).toBe(0);
    expect(retryDelayMs("Wed, 14 Oct 2026 10:30:05 GMT", 0, () => 1, Date.parse("2026-10-14T10:30:00Z"))).toBe(5000);
    expect(retryDelayMs("Wed, 14 Oct 2026 10:29:00 GMT", 0, () => 1, Date.parse("2026-10-14T10:30:00Z"))).toBe(0); // a date in the past
  });

  it("otherwise backs off exponentially, with 50-100% jitter", () => {
    expect(retryDelayMs(null, 0, () => 1)).toBe(1000);
    expect(retryDelayMs(null, 1, () => 1)).toBe(2000);
    expect(retryDelayMs(null, 2, () => 1)).toBe(4000);
    expect(retryDelayMs(null, 2, () => 0)).toBe(2000); // the lowest jitter is half
    expect(retryDelayMs("garbage", 0, () => 1)).toBe(1000);
    expect(retryDelayMs("", 0, () => 1)).toBe(1000);
  });
});

describe("streamCompletion and rate limits (HTTP 429)", () => {
  const ok = () => sse([delta({ content: "fine" }, "stop"), "data: [DONE]"]);
  const limited = (retryAfter?: string) => new Response("slow down", { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} });

  // Runs with a recording sleep (no real waiting) and a fixed jitter.
  function rateRun(responses: (() => Response)[], retry: { maxRetries?: number } = {}, signal = new AbortController().signal) {
    const sleeps: number[] = [];
    const retries: { attempt: number; waitMs: number }[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      const next = responses[Math.min(calls, responses.length - 1)] as () => Response;
      calls++;
      return next();
    }) as typeof fetch;
    const promise = streamCompletion({
      llm,
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal,
      onText: () => undefined,
      fetchImpl,
      retry: { ...retry, sleep: async (ms) => void sleeps.push(ms), random: () => 1, onRetry: (i) => retries.push(i) },
    });
    return { promise, sleeps, retries, calls: () => calls };
  }

  it("waits as long as Retry-After says, tells the caller, then succeeds", async () => {
    const r = rateRun([() => limited("2"), ok]);
    expect((await r.promise).content).toBe("fine");
    expect(r.sleeps).toEqual([2000]);
    expect(r.retries).toEqual([{ attempt: 1, waitMs: 2000 }]);
    expect(r.calls()).toBe(2);
  });

  it("backs off 1 s, 2 s, 4 s without a Retry-After, then gives up with a clear message", async () => {
    const r = rateRun([() => limited()]);
    const err = await r.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as Error).message).toMatch(/rate limiting.*429/);
    expect(r.sleeps).toEqual([1000, 2000, 4000]);
    expect(r.calls()).toBe(4); // the first try plus three retries
  });

  it("respects a smaller retry budget", async () => {
    const r = rateRun([() => limited("0")], { maxRetries: 1 });
    await r.promise.catch(() => undefined);
    expect(r.calls()).toBe(2);
  });

  it("does not hold a chat open for a long wait: it says how long the API asked for", async () => {
    const r = rateRun([() => limited(String(MAX_RETRY_WAIT_MS / 1000 + 25))]);
    const err = await r.promise.catch((e: unknown) => e);
    expect((err as Error).message).toContain("45 s");
    expect(r.sleeps).toEqual([]);
    expect(r.calls()).toBe(1);
  });

  it("retries ONLY rate limits: a 500 is reported at once", async () => {
    const r = rateRun([() => new Response("boom", { status: 500 }), ok]);
    const err = await r.promise.catch((e: unknown) => e);
    expect((err as Error).message).toContain("HTTP 500");
    expect(r.calls()).toBe(1);
  });

  it("stops waiting when the user leaves, and that is not reported as an API error", async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => limited("5")) as typeof fetch;
    const promise = streamCompletion({
      llm,
      messages: [],
      tools: [],
      signal: controller.signal,
      onText: () => undefined,
      fetchImpl,
      retry: { sleep: (_ms, signal) => new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) },
    });
    setTimeout(() => controller.abort(new DOMException("aborted", "AbortError")), 10);
    const err = await promise.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(LlmError);
  });
});
