import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import express, { Router } from "express";
import { z } from "zod";
import { currentUser } from "../auth/guards.js";
import { runChat, type ChatEvent, type ToolRunner } from "../chat/agent.js";
import { safeTimeZone } from "../chat/prompt.js";
import { LlmError, type LlmConfig } from "../chat/llm.js";
import type { Config } from "../config.js";
import { HttpError, parse } from "../http.js";
import { createGatewayServer } from "../mcp/gatewayServer.js";
import type { Principal } from "../mcp/principal.js";
import type { RouteDeps } from "./deps.js";

// All three settings are needed; with any missing, chat is simply "not configured".
function llmFromConfig(config: Config): LlmConfig | undefined {
  const { LLM_BASE_URL, LLM_MODEL, LLM_API_KEY } = config;
  return LLM_BASE_URL && LLM_MODEL && LLM_API_KEY ? { baseUrl: LLM_BASE_URL, model: LLM_MODEL, apiKey: LLM_API_KEY } : undefined;
}

// The browser sends the conversation so far (plain text only; tool calls live inside one request).
const body = z.object({
  // The browser's time zone, so the assistant knows what "today" means for this person.
  timezone: z.string().max(64).optional(),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8_000) }))
    .min(1)
    .max(30)
    .refine((m) => m[m.length - 1]?.role === "user", "the last message must be from the user"),
});

export function chatRoutes({ db, config, logger, requireLogin, upstreams }: RouteDeps): Router {
  const router = Router();
  router.use(requireLogin);

  router.get("/status", (_req, res) => {
    const llm = llmFromConfig(config);
    res.json({ enabled: llm !== undefined, model: llm?.model ?? null });
  });

  // Has its own body parser (mounted before the general /api one in app.ts) because a conversation
  // can be bigger than the 100 kb limit used for the rest of the API.
  router.post("/", express.json({ limit: "512kb" }), async (req, res) => {
    const llm = llmFromConfig(config);
    if (!llm) throw new HttpError(503, "Chat is not configured on this server (LLM_BASE_URL, LLM_MODEL and LLM_API_KEY are not all set)");
    const { messages, timezone } = parse(body, req.body);
    const user = currentUser(res);

    // From here on the answer is a stream of Server-Sent Events: one `data: {json}` line per event.
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // tells nginx-style proxies not to hold the stream back
    });
    res.flushHeaders();
    const send = (event: ChatEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // A comment line every 15 s keeps proxies from closing the connection during a slow tool call.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15_000);

    // If the browser goes away, stop paying for model tokens and stop calling tools.
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    // The chat agent is just another MCP client of the gateway: the SAME server object the HTTP
    // endpoint uses, wired through an in-memory pipe. So permission checks and audit records apply
    // unchanged; the principal's source is "chat" and there is no API key.
    const principal: Principal = { userId: user.id, role: user.role, apiKeyId: null, source: "chat" };
    const gateway = createGatewayServer(principal, { db, logger, upstreams });
    const client = new Client({ name: "dashboard-chat", version: "0.1.0" });
    try {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await gateway.connect(serverSide);
      await client.connect(clientSide);

      const runner: ToolRunner = {
        list: async () => (await client.listTools()).tools,
        call: async (name, args) => {
          const result = await client.callTool({ name, arguments: args });
          const text = (result.content as { type: string; text?: string }[])
            .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content]`))
            .join("\n");
          return { text, isError: result.isError === true };
        },
      };
      await runChat({ llm, runner, history: messages, emit: send, signal: abort.signal, timeZone: safeTimeZone(timezone) });
    } catch (err) {
      if (!abort.signal.aborted) {
        if (!(err instanceof LlmError)) logger.error({ err }, "chat failed");
        send({ type: "error", message: err instanceof LlmError ? err.message : "The assistant hit an unexpected error." });
      }
    } finally {
      clearInterval(heartbeat);
      await client.close().catch(() => undefined);
      await gateway.close().catch(() => undefined);
      res.end();
    }
  });

  return router;
}
