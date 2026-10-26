import { describe, expect, it } from "vitest";
import { parseSseBuffer, readChatStream } from "./chatStream.js";

const block = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe("parseSseBuffer", () => {
  it("returns complete events and keeps the unfinished tail", () => {
    const text = block({ type: "text", delta: "Hel" }) + block({ type: "done" }) + 'data: {"type":"te';
    const { events, rest } = parseSseBuffer(text);
    expect(events).toEqual([{ type: "text", delta: "Hel" }, { type: "done" }]);
    expect(rest).toBe('data: {"type":"te');
  });

  it("ignores heartbeats and malformed blocks", () => {
    const { events } = parseSseBuffer(": ping\n\n" + "data: {broken\n\n" + block({ type: "done" }));
    expect(events).toEqual([{ type: "done" }]);
  });
});

describe("readChatStream", () => {
  it("reassembles events that were split across chunks, and CRLF line endings", async () => {
    const payload = (block({ type: "text", delta: "a" }) + block({ type: "tool_call", id: "1", name: "x", args: {} }) + block({ type: "done" })).replace(/\n/g, "\r\n");
    const bytes = new TextEncoder().encode(payload);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 9) c.enqueue(bytes.slice(i, i + 9));
        c.close();
      },
    });
    const types: string[] = [];
    for await (const e of readChatStream(stream)) types.push(e.type);
    expect(types).toEqual(["text", "tool_call", "done"]);
  });
});
