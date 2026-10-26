import { AlertCircle, Check, ChevronRight, Loader2, MessageSquare, Send, Square, Wrench } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { QueryError } from "@/components/QueryError";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/input";
import { readChatStream } from "@/lib/chatStream";
import { formatDuration, splitToolName } from "@/lib/format";
import { useChatStatus } from "@/lib/queries";
import type { ChatEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

// An assistant message is a list of parts in the order they happened: text, then a tool call,
// then more text...
type Part =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown>; state: "running" | "ok" | "error"; durationMs?: number; result?: string; truncated?: boolean };

interface Message {
  id: number;
  role: "user" | "assistant";
  parts: Part[];
  error?: string;
  /** A passing status line, e.g. while the model API asks us to slow down. Cleared by the next real event. */
  notice?: string;
}

// Folds one streamed event into the assistant message being built. Pure, so streaming is easy to reason about.
function applyEvent(parts: Part[], event: ChatEvent): Part[] {
  switch (event.type) {
    case "text": {
      const last = parts[parts.length - 1];
      if (last?.kind === "text") return [...parts.slice(0, -1), { kind: "text", text: last.text + event.delta }];
      return [...parts, { kind: "text", text: event.delta }];
    }
    case "tool_call":
      return [...parts, { kind: "tool", id: event.id, name: event.name, args: event.args, state: "running" }];
    case "tool_result":
      return parts.map((p) => (p.kind === "tool" && p.id === event.id ? { ...p, state: event.isError ? "error" : "ok", durationMs: event.durationMs, result: event.result, truncated: event.truncated } : p));
    default:
      return parts;
  }
}

const textOf = (m: Message) => m.parts.filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text").map((p) => p.text).join("");

export function ChatPage() {
  const status = useChatStatus();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const nextId = useRef(1);

  // Keep the newest text in view while it streams.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);
  // Leaving the page cancels an answer in progress (and with it the model call and any tool calls).
  useEffect(() => () => abortRef.current?.abort(), []);

  const update = (id: number, fn: (m: Message) => Message) => setMessages((all) => all.map((m) => (m.id === id ? fn(m) : m)));

  async function send(text: string) {
    const userMsg: Message = { id: nextId.current++, role: "user", parts: [{ kind: "text", text }] };
    const botMsg: Message = { id: nextId.current++, role: "assistant", parts: [] };
    // Only plain text goes back to the server as history; tool calls live inside a single answer.
    const history = [...messages, userMsg].map((m) => ({ role: m.role, content: textOf(m) })).filter((m) => m.content !== "");
    setMessages((all) => [...all, userMsg, botMsg]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The time zone lets the assistant understand "today" and "yesterday" the way you do.
        body: JSON.stringify({ messages: history, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        signal: controller.signal,
        credentials: "same-origin",
      });
      if (!res.ok || !res.body) {
        const data: unknown = await res.json().catch(() => null);
        const message = (data as { error?: unknown } | null)?.error;
        throw new Error(typeof message === "string" ? message : `Request failed (HTTP ${res.status})`);
      }
      for await (const event of readChatStream(res.body)) {
        if (event.type === "error") update(botMsg.id, (m) => ({ ...m, notice: undefined, error: event.message }));
        else if (event.type === "retry") update(botMsg.id, (m) => ({ ...m, notice: `The model is busy (rate limited). Trying again in ${Math.max(1, Math.ceil(event.waitMs / 1000))} s...` }));
        else update(botMsg.id, (m) => ({ ...m, notice: undefined, parts: applyEvent(m.parts, event) }));
      }
    } catch (err) {
      if (!controller.signal.aborted) update(botMsg.id, (m) => ({ ...m, error: err instanceof Error ? err.message : "The connection was interrupted." }));
    } finally {
      // Anything still marked "running" when the stream ends was cut off.
      update(botMsg.id, (m) => ({ ...m, parts: m.parts.map((p) => (p.kind === "tool" && p.state === "running" ? { ...p, state: "error", result: p.result ?? "Stopped before this finished." } : p)) }));
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    void send(text);
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault(); // Enter sends, Shift+Enter adds a line
      submit();
    }
  };

  if (status.isPending) return <Skeleton className="h-96 w-full" />;
  if (status.isError) return <QueryError error={status.error} onRetry={() => void status.refetch()} />;
  if (!status.data.enabled) {
    return (
      <>
        <PageHeader title="Chat" />
        <EmptyState
          icon={MessageSquare}
          title="Chat is not set up"
          description="An administrator needs to connect a language model: set LLM_BASE_URL, LLM_MODEL and LLM_API_KEY on the gateway. Any OpenAI-compatible API works."
        />
      </>
    );
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-[28rem] flex-col">
      <PageHeader
        title="Chat"
        description={`Ask in plain language. The assistant (${status.data.model}) can use every tool you can, and each call is audited.`}
        actions={messages.length > 0 && <Button variant="outline" size="sm" disabled={streaming} onClick={() => setMessages([])}>New chat</Button>}
      />

      <div className="flex-1 space-y-6 overflow-y-auto rounded-lg border bg-card p-4 sm:p-6" aria-live="polite">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <MessageSquare className="mb-3 h-8 w-8 text-primary/60" />
            <p>Try: "What tools do you have?" or "Convert 250 USD to EUR".</p>
          </div>
        )}
        {messages.map((m, i) => (
          <MessageView key={m.id} message={m} pending={streaming && i === messages.length - 1} />
        ))}
        <div ref={endRef} />
      </div>

      <form onSubmit={submit} className="mt-4 flex items-end gap-2">
        <Textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown} placeholder="Message the assistant" rows={1} className="max-h-40 flex-1 resize-none" aria-label="Message" maxLength={8000} />
        {streaming ? (
          <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}>
            <Square /> Stop
          </Button>
        ) : (
          <Button type="submit" disabled={input.trim() === ""}>
            <Send /> Send
          </Button>
        )}
      </form>
    </div>
  );
}

function MessageView({ message, pending }: { message: Message; pending: boolean }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[85%] space-y-3 text-sm", isUser && "rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-primary-foreground")}>
        {message.parts.map((p, i) =>
          p.kind === "text" ? (
            <p key={i} className="whitespace-pre-wrap leading-relaxed">{p.text}</p>
          ) : (
            <ToolChip key={p.id} part={p} />
          ),
        )}
        {message.notice && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {message.notice}
          </p>
        )}
        {pending && message.parts.length === 0 && !message.error && !message.notice && (
          <span className="inline-flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Thinking</span>
        )}
        {message.error && (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {message.error}
          </p>
        )}
      </div>
    </div>
  );
}

// A collapsed pill per tool call; open it to see exactly what was sent and what came back.
function ToolChip({ part }: { part: Extract<Part, { kind: "tool" }> }) {
  const { server, tool } = splitToolName(part.name);
  const hasArgs = Object.keys(part.args).length > 0;
  return (
    <Collapsible className="rounded-lg border bg-background text-foreground">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left text-xs">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {server && <Badge variant="outline" className="font-mono">{server}</Badge>}
        <span className="truncate font-mono font-medium">{tool}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {part.durationMs !== undefined && <span className="tabular-nums text-muted-foreground">{formatDuration(part.durationMs)}</span>}
          {part.state === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-label="Running" />}
          {part.state === "ok" && <Check className="h-3.5 w-3.5 text-success" aria-label="Succeeded" />}
          {part.state === "error" && <AlertCircle className="h-3.5 w-3.5 text-destructive" aria-label="Failed" />}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 border-t px-3 py-3">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Arguments</p>
          <pre className="max-h-48 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs">{hasArgs ? JSON.stringify(part.args, null, 2) : "(none)"}</pre>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {part.state === "error" ? "Error" : "Result"}
            {part.truncated && <span className="ml-1 font-normal">(preview, cut short)</span>}
          </p>
          <pre className={cn("max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-xs", part.state === "error" && "text-destructive")}>
            {part.result ?? (part.state === "running" ? "Waiting for the result..." : "")}
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
