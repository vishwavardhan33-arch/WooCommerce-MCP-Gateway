import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type ErrorRequestHandler, type Express } from "express";
import { bearerAuth } from "./auth.js";
import { createMcpServer } from "./server.js";
import type { ToolContext } from "./tools/context.js";

export interface AppOptions {
  authToken: string;
  ctx: ToolContext;
  /** Becomes true on SIGTERM so /readyz fails and the pod is taken out of rotation. */
  isShuttingDown?: () => boolean;
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0" as const, error: { code, message }, id: null });

export function createApp(opts: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");

  // Probes carry no token (the kubelet cannot send one), so they are registered BEFORE the auth middleware.
  // /healthz = the process is alive. /readyz = it can take traffic. Neither calls Frankfurter: if the
  // API is down, tools return a clear isError result while the pod stays in rotation. Making
  // readiness depend on a third party would take every replica out of rotation at once.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/readyz", (_req, res) => {
    if (opts.isShuttingDown?.()) {
      res.status(503).json({ status: "shutting_down" });
      return;
    }
    res.json({ status: "ready" });
  });

  app.use("/mcp", bearerAuth(opts.authToken));

  // STATELESS: a fresh MCP server and transport for every request. No session id is issued,
  // so there is nothing to keep between requests and any replica can serve any request.
  app.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
    const server = createMcpServer(opts.ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // undefined = stateless mode
      enableJsonResponse: true, // plain JSON reply instead of an event stream: one request, one response
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      opts.ctx.logger.error({ err }, "mcp request failed");
      if (!res.headersSent) res.status(500).json(rpcError(-32603, "Internal server error"));
    }
  });

  // Without sessions there is no server-to-client stream to open (GET) or session to end (DELETE).
  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json(rpcError(-32000, "Method not allowed: this server is stateless, use POST"));
  });

  // Malformed JSON bodies and other errors raised before the handler runs.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express only treats a function with 4 parameters as an error handler
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json(status === 500 ? rpcError(-32603, "Internal server error") : rpcError(-32700, "Parse error"));
  };
  app.use(onError);

  return app;
}
