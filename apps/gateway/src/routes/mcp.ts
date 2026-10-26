import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Router, type ErrorRequestHandler } from "express";
import { apiKeyAuth, getPrincipal } from "../mcp/auth.js";
import { createGatewayServer, type GatewayDeps } from "../mcp/gatewayServer.js";
import { rpcError } from "../mcp/rpc.js";

export function mcpRoutes(deps: GatewayDeps): Router {
  const router = Router();

  // Auth first: an unauthenticated request must not even get its body parsed.
  router.use(apiKeyAuth(deps.db, deps.logger));

  // STATELESS, like woo-mcp: a fresh server and transport for every request, no session id is
  // issued, so any replica can answer any request. The server is built for THIS request's principal.
  router.post("/", express.json({ limit: "1mb" }), async (req, res) => {
    const server = createGatewayServer(getPrincipal(res), deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // undefined = stateless mode
      enableJsonResponse: true, // one request, one plain JSON response
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      deps.logger.error({ err }, "mcp request failed");
      if (!res.headersSent) res.status(500).json(rpcError(-32603, "Internal server error"));
    }
  });

  // Without sessions there is no server-to-client stream to open (GET) or session to end (DELETE).
  router.all("/", (_req, res) => {
    res.status(405).set("Allow", "POST").json(rpcError(-32000, "Method not allowed: this server is stateless, use POST"));
  });

  // MCP clients expect JSON-RPC shaped errors, so bad JSON gets one here instead of the REST handler's.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express only treats a function with 4 parameters as an error handler
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const clientError = typeof err?.status === "number" && err.status >= 400 && err.status < 500;
    if (!clientError) deps.logger.error({ err }, "mcp request failed");
    res.status(clientError ? err.status : 500).json(clientError ? rpcError(-32700, "Parse error") : rpcError(-32603, "Internal server error"));
  };
  router.use(onError);

  return router;
}
