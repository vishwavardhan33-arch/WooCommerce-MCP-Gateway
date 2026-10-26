import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { UpstreamManager } from "../upstream/manager.js";
import { fail } from "../upstream/result.js";
import { writeCallAudit, type AuditStatus } from "./audit.js";
import { loadDisabledTools, policyKey } from "./policies.js";
import type { Principal } from "./principal.js";

export interface GatewayDeps {
  db: Db;
  logger: Logger;
  upstreams: UpstreamManager;
}

const SERVER_NAME = "mcp-gateway";
const SERVER_VERSION = "0.1.0";

/**
 * An MCP server that is the gateway: it has no tools of its own, it shows and forwards the tools of
 * every upstream, on behalf of ONE principal. It is exported because the HTTP endpoint and the chat
 * agent build it the same way: connect it to any transport (HTTP, or in-memory for the agent) and
 * the permission checks and audit records come with it.
 *
 * The low-level Server class (not McpServer) is used because McpServer wants every tool registered
 * up front with a schema, while our tools appear and disappear as upstreams come and go.
 */
export function createGatewayServer(principal: Principal, deps: GatewayDeps): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  // tools/list: straight from the cache (no upstream is contacted), minus anything an admin disabled.
  // If the policies cannot be read we let the error propagate instead of listing everything: unknown
  // permissions mean no list, not a full one.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const disabled = await loadDisabledTools(deps.db);
    const tools = deps.upstreams
      .listEntries()
      .filter((entry) => !disabled.has(policyKey(entry.serverId, entry.original)))
      .map((entry) => entry.tool);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleCall(principal, deps, request.params.name, request.params.arguments),
  );

  return server;
}

// One tool call: check permission, forward, audit. NEVER throws: every problem becomes an isError
// result with a message the client can act on.
async function handleCall(
  principal: Principal,
  deps: GatewayDeps,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const started = Date.now();
  const target = deps.upstreams.locate(name);

  let result: CallToolResult;
  let status: AuditStatus;
  try {
    // Hidden tools are also REJECTED here: hiding from tools/list is not security, because a client
    // can call any name it guesses. This is the check that actually enforces the policy.
    const disabled = target?.original ? await loadDisabledTools(deps.db) : undefined;
    if (target?.original && disabled?.has(policyKey(target.serverId, target.original))) {
      result = fail(`The tool "${name}" is disabled by an administrator.`);
      status = "denied";
    } else {
      result = await deps.upstreams.callTool(name, args);
      status = result.isError ? "error" : "ok";
    }
  } catch (err) {
    // Reaching here means a bug or a database outage while checking permissions. Failing closed
    // (no call is made) is the safe answer when permissions cannot be verified.
    deps.logger.error({ err, tool: name }, "tool call failed inside the gateway");
    result = fail("The gateway hit an internal error and could not complete this call.");
    status = "error";
  }

  await writeCallAudit(deps.db, deps.logger, {
    principal,
    requestedName: name,
    server: target?.slug ?? null,
    tool: target?.original ?? null,
    durationMs: Date.now() - started,
    status,
    result,
    args,
  });
  return result;
}
