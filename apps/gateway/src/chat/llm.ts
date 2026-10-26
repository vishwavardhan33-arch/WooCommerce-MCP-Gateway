// A minimal client for the OpenAI-compatible "chat completions" API with streaming and tool calls.
// Many providers speak it (OpenAI, Groq, OpenRouter, Gemini's compatibility endpoint, Ollama), so one
// small client covers all of them and the choice of provider is just three environment variables.

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters?: unknown };
}

export interface Completion {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

export class LlmError extends Error {}

export interface RetryOptions {
  /** How many times to try again after a 429. Default 3 (so at most 4 requests). */
  maxRetries?: number;
  /** Replaceable in tests so they do not really wait. Must reject if the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 0..1, replaceable in tests so the backoff is exact. */
  random?: () => number;
  /** Called before each wait, so the UI can say "rate limited, retrying in 2 s". */
  onRetry?: (info: { attempt: number; waitMs: number }) => void;
}

export interface StreamOptions {
  llm: LlmConfig;
  messages: ChatMessage[];
  tools: OpenAiTool[];
  signal: AbortSignal;
  /** Called with each piece of text as it arrives, so the UI can show it immediately. */
  onText: (delta: string) => void;
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
}

const BASE_BACKOFF_MS = 1_000;
// Longer waits than this are not worth holding a chat open for: say so instead (free tiers often
// answer "retry in 40 s", and nobody wants a spinner that long).
export const MAX_RETRY_WAIT_MS = 20_000;

/**
 * How long to wait before retrying a 429.
 * 1. If the API says (Retry-After, seconds or a date), believe it.
 * 2. Otherwise back off exponentially: 1 s, 2 s, 4 s..., each multiplied by a random 50-100%
 *    ("jitter") so many clients that were limited at the same moment do not all come back at once.
 */
export function retryDelayMs(retryAfter: string | null, attempt: number, random: () => number, now: number = Date.now()): number {
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  return Math.round(BASE_BACKOFF_MS * 2 ** attempt * (0.5 + random() * 0.5));
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

interface Chunk {
  choices?: {
    delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
}

// Streaming responses are Server-Sent Events: lines like `data: {json}` ending with `data: [DONE]`.
// Text arrives in small deltas. A tool call arrives in PIECES (its arguments are a JSON string sent
// a few characters at a time), tagged with an index, so we glue the pieces together per index.
export async function streamCompletion(opts: StreamOptions): Promise<Completion> {
  const { llm, messages, tools, signal, onText } = opts;
  const doFetch = opts.fetchImpl ?? fetch;

  const maxRetries = opts.retry?.maxRetries ?? 3;
  const sleep = opts.retry?.sleep ?? defaultSleep;
  const random = opts.retry?.random ?? Math.random;

  let response: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await doFetch(`${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({ model: llm.model, messages, stream: true, ...(tools.length > 0 ? { tools } : {}) }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err; // the user left: let the caller treat it as a cancellation
      throw new LlmError(`The language model API could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 429 = "too many requests". It arrives as a status BEFORE any text, so retrying is safe: nothing
    // has been shown to the user yet.
    if (response.status !== 429 || attempt >= maxRetries) break;
    const waitMs = retryDelayMs(response.headers.get("retry-after"), attempt, random);
    await response.body?.cancel().catch(() => undefined); // release the connection of the rejected attempt
    if (waitMs > MAX_RETRY_WAIT_MS) {
      throw new LlmError(`The language model API is rate limiting requests and asks us to wait ${Math.ceil(waitMs / 1000)} s. Try again in a little while.`);
    }
    opts.retry?.onRetry?.({ attempt: attempt + 1, waitMs });
    await sleep(waitMs, signal);
  }

  if (!response.ok) {
    // The provider's error text is useful ("model not found", "quota exceeded"); our key is never in it.
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    const what =
      response.status === 429
        ? "The language model API is still rate limiting requests after several retries (HTTP 429)"
        : `The language model API answered HTTP ${response.status}`;
    throw new LlmError(`${what}${detail ? `: ${detail}` : ""}`);
  }
  if (!response.body) throw new LlmError("The language model API sent an empty response");

  let content = "";
  let finishReason: string | null = null;
  const calls: { id: string; name: string; arguments: string }[] = [];

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return; // blank lines and ": keep-alive" comments
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") return;
    let chunk: Chunk;
    try {
      chunk = JSON.parse(payload) as Chunk;
    } catch {
      return; // a malformed chunk is skipped rather than failing the whole answer
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.delta?.content) {
      content += choice.delta.content;
      onText(choice.delta.content);
    }
    for (const piece of choice.delta?.tool_calls ?? []) {
      const slot = (calls[piece.index ?? 0] ??= { id: "", name: "", arguments: "" });
      if (piece.id) slot.id = piece.id;
      if (piece.function?.name) slot.name = piece.function.name;
      if (piece.function?.arguments) slot.arguments += piece.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  // Chunks of bytes do not respect line boundaries: keep the unfinished last line for the next read.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line.trimEnd());
  }
  if (buffer) handleLine(buffer.trimEnd());

  const toolCalls: ToolCall[] = calls
    .filter((c) => c && c.name) // `calls` can have holes if indexes skip
    .map((c, i) => ({
      // Some providers omit the id; the API requires one to pair each result with its call.
      id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 10)}`,
      type: "function" as const,
      function: { name: c.name, arguments: c.arguments },
    }));
  return { content, toolCalls, finishReason };
}
