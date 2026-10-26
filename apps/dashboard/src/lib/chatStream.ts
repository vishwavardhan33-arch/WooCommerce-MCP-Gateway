import type { ChatEvent } from "./types.js";

// The chat endpoint answers with Server-Sent Events: blocks of lines separated by a blank line, each
// block holding `data: {json}`. Network chunks do not respect block boundaries, so the parser keeps
// the unfinished tail (`rest`) and the caller feeds it back with the next chunk.
export function parseSseBuffer(buffer: string): { events: ChatEvent[]; rest: string } {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: ChatEvent[] = [];
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue; // a ": ping" heartbeat has no data lines
    try {
      events.push(JSON.parse(data) as ChatEvent);
    } catch {
      // A malformed block is skipped rather than ending the whole conversation.
    }
  }
  return { events, rest };
}

export async function* readChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // Normalise line endings on the WHOLE buffer, not per chunk: a "\r" can end one chunk while its
    // "\n" starts the next, and a per-chunk replace would never see them together.
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
    const parsed = parseSseBuffer(buffer);
    buffer = parsed.rest;
    yield* parsed.events;
  }
}
