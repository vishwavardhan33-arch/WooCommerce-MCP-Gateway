import { streamCompletion, type ChatMessage, type LlmConfig, type OpenAiTool, type RetryOptions } from "./llm.js";
import { buildSystemPrompt } from "./prompt.js";
import { toFunctionParameters } from "./schema.js";

// The chat agent: ask the model; if it wants tools, run them and show it the results; repeat until
// it answers in plain text. It knows nothing about MCP or HTTP: tools come in through `ToolRunner`
// and progress goes out through `emit`, which keeps this loop small and testable.

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface ToolRunner {
  list(): Promise<ToolDef[]>;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

// What the dashboard receives, one JSON object per Server-Sent Event.
//   tool_call   a tool is about to run (name and arguments), so the UI can show it as "running"
//   tool_result the same call finished: its duration and a PREVIEW of the result (cut to
//               RESULT_PREVIEW_CHARS; `truncated` says whether anything was cut)
//   retry       the model API said "too many requests"; we are waiting before trying again
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; isError: boolean; durationMs: number; result: string; truncated: boolean }
  | { type: "retry"; attempt: number; waitMs: number }
  | { type: "error"; message: string }
  | { type: "done" };

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export const MAX_STEPS = 8; // a model that keeps calling tools forever must not run forever
const RESULT_PREVIEW_CHARS = 2_000; // what the UI shows
const MODEL_RESULT_CHARS = 16_000; // what the model gets back: bounded so one huge result cannot eat the context

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text);

const toOpenAiTool = (t: ToolDef): OpenAiTool => ({
  type: "function",
  // `parameters` is left out for a tool without arguments (see schema.ts).
  function: { name: t.name, description: t.description ?? "", parameters: toFunctionParameters(t.inputSchema) },
});

export interface RunChatOptions {
  llm: LlmConfig;
  runner: ToolRunner;
  history: HistoryMessage[];
  emit: (event: ChatEvent) => void;
  signal: AbortSignal;
  /** IANA name such as "Asia/Kolkata"; already validated (see prompt.ts). */
  timeZone: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  maxSteps?: number;
  retry?: Omit<RetryOptions, "onRetry">;
}

export async function runChat(opts: RunChatOptions): Promise<void> {
  const { llm, runner, history, emit, signal } = opts;
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const tools = (await runner.list()).map(toOpenAiTool);
  const messages: ChatMessage[] = [{ role: "system", content: buildSystemPrompt((opts.now ?? (() => new Date()))(), opts.timeZone) }, ...history];

  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) return;
    const completion = await streamCompletion({
      llm,
      messages,
      tools,
      signal,
      fetchImpl: opts.fetchImpl,
      retry: { ...opts.retry, onRetry: ({ attempt, waitMs }) => emit({ type: "retry", attempt, waitMs }) },
      onText: (delta) => emit({ type: "text", delta }),
    });

    if (completion.toolCalls.length === 0) {
      emit({ type: "done" });
      return;
    }

    messages.push({ role: "assistant", content: completion.content || null, tool_calls: completion.toolCalls });
    for (const call of completion.toolCalls) {
      let args: Record<string, unknown> = {};
      let argsError: string | undefined;
      try {
        const parsed: unknown = call.function.arguments.trim() === "" ? {} : JSON.parse(call.function.arguments);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        args = parsed as Record<string, unknown>;
      } catch {
        argsError = "The tool arguments were not a valid JSON object, so the tool was not called. Try again with valid arguments.";
      }

      emit({ type: "tool_call", id: call.id, name: call.function.name, args });
      const started = Date.now();
      let outcome: { text: string; isError: boolean };
      if (argsError) {
        outcome = { text: argsError, isError: true };
      } else {
        try {
          outcome = await runner.call(call.function.name, args);
        } catch (err) {
          outcome = { text: `The tool call failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }
      emit({
        type: "tool_result",
        id: call.id,
        name: call.function.name,
        isError: outcome.isError,
        durationMs: Date.now() - started,
        result: cut(outcome.text, RESULT_PREVIEW_CHARS),
        truncated: outcome.text.length > RESULT_PREVIEW_CHARS,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: cut(outcome.text, MODEL_RESULT_CHARS) });
    }
  }
  emit({ type: "error", message: `The assistant stopped after ${maxSteps} rounds of tool calls without finishing.` });
}
