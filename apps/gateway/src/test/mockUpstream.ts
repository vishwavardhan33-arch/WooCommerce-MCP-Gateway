import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface MockTool {
  name: string;
  description?: string;
  /** What the tool does when called. Default: answers "<name> ok". */
  run?: () => Promise<CallToolResult> | CallToolResult;
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0" as const, error: { code, message }, id: null });

// A REAL MCP server over HTTP that tests can misbehave on purpose: make it slow, kill it and bring
// it back, make it forget its sessions, make it demand a token. Unlike woo-mcp it is STATEFUL
// (it hands out session ids), because session expiry is one of the things the gateway must survive.
export class MockUpstream {
  port = 0;
  /** Added to EVERY request before it is handled: simulates a slow or hung server. */
  delayMs = 0;
  /** When set, requests without "Authorization: Bearer <token>" get 401. */
  token: string | undefined;
  /** Original names of the tools that were actually called. */
  calls: string[] = [];
  /** Every HTTP request that arrived (before delay and auth): proves whether the gateway even tried. */
  requests = 0;
  sessionsCreated = 0;

  private sessions = new Map<string, StreamableHTTPServerTransport>();
  private server: Server | undefined;

  constructor(public tools: MockTool[]) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(): Promise<void> {
    const app = express();
    app.use(express.json());

    app.post("/mcp", async (req, res) => {
      try {
        await this.handle(req, res);
      } catch {
        // A request that outlives its test (slow on purpose) can wake up after the server was shut
        // down and find a dead socket. That is expected here, not a failure.
      }
    });
    app.all("/mcp", (_req, res) => {
      res.status(405).set("Allow", "POST").json(rpcError(-32000, "Method not allowed"));
    });

    await new Promise<void>((resolve) => {
      // Restarting reuses the same port, so the gateway's registered URL stays valid.
      this.server = app.listen(this.port, "127.0.0.1", resolve);
    });
    this.port = (this.server?.address() as AddressInfo).port;
  }

  private async handle(req: Request, res: Response): Promise<void> {
    this.requests++;
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (this.token && req.header("authorization") !== `Bearer ${this.token}`) {
      res.status(401).json(rpcError(-32001, "Unauthorized"));
      return;
    }

    const sessionId = req.header("mcp-session-id");
    let transport = sessionId ? this.sessions.get(sessionId) : undefined;
    // The MCP spec: a request carrying a session id the server does not know gets 404.
    if (sessionId && !transport) {
      res.status(404).json(rpcError(-32001, "Session not found"));
      return;
    }
    if (!transport) {
      if (!isInitializeRequest(req.body)) {
        res.status(400).json(rpcError(-32000, "Bad Request: no session id"));
        return;
      }
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          this.sessions.set(id, created);
        },
      });
      this.sessionsCreated++;
      await this.buildServer().connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, req.body);
  }

  /** Simulates a crash: connections are cut and all sessions are forgotten, like a restart would. */
  async stop(): Promise<void> {
    this.sessions.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The server stays up but forgets every session: the next request on an old session gets 404. */
  expireSessions(): void {
    this.sessions.clear();
  }

  private buildServer(): McpServer {
    const server = new McpServer({ name: "mock-upstream", version: "1.0.0" });
    for (const tool of this.tools) {
      server.registerTool(
        tool.name,
        // No inputSchema: the tests never need arguments, and a tool without one accepts any call.
        { description: tool.description },
        async () => {
          this.calls.push(tool.name);
          return tool.run ? tool.run() : { content: [{ type: "text" as const, text: `${tool.name} ok` }] };
        },
      );
    }
    return server;
  }
}
