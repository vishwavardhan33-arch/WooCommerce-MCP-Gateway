import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { decryptCredential } from "../crypto.js";
import type { Logger } from "../logger.js";
import { describeWithSlug, namespacedName } from "./namespacing.js";
import { fail } from "./result.js";
import { assertUrlAllowed, type SsrfOptions } from "./ssrf.js";

// Mirrors the mcp_server_status enum in the database. "down" is what the dashboard calls Unreachable.
export type UpstreamState = "unknown" | "up" | "down";

export interface UpstreamConfig {
  id: string;
  slug: string;
  url: string;
  authType: "none" | "bearer";
  credentialEnc: string | null;
  timeoutMs: number;
}

/** Sent to the manager whenever something worth storing in the database changed. */
export interface StatusEvent {
  id: string;
  state: UpstreamState;
  lastError: string | null;
  /** true only when `state` itself changed (that is when status_since must be reset). */
  stateChanged: boolean;
}

export interface UpstreamDeps {
  logger: Logger;
  credentialKey: Buffer;
  ssrf: SsrfOptions;
  /** Consecutive failures that open the circuit breaker. */
  failureThreshold: number;
  onChange: (event: StatusEvent) => Promise<void>;
}

// The upstream's tools as WE publish them: `tool` has the namespaced name and prefixed description,
// `original` is the name the upstream knows, which is what we send when forwarding a call.
interface CachedTool {
  namespaced: string;
  original: string;
  tool: Tool;
}

// Our own error types for failures we detect ourselves (bad configuration, timeouts).
class UpstreamError extends Error {}
class UpstreamTimeout extends UpstreamError {}

const MAX_TOOL_PAGES = 20; // tools/list is paginated; a bound stops a broken server from looping us forever

// Runs `run` with a deadline. Two layers on purpose:
//  - the AbortSignal is handed to the SDK so it cancels the real HTTP request when time is up;
//  - Promise.race guarantees WE give up on time even if something ignores the signal.
// Whatever the SDK rejects with after the abort, we report one clear "timed out" error.
async function withTimeout<T>(ms: number, what: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  const message = `${what} timed out after ${ms} ms`;
  const deadline = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new UpstreamTimeout(message)), { once: true });
  });
  try {
    return await Promise.race([run(signal), deadline]);
  } catch (err) {
    if (signal.aborted) throw new UpstreamTimeout(message);
    throw err;
  }
}

// The server forgot our session (it restarted, or the session expired). The MCP spec says to
// answer a request with an unknown session id with HTTP 404; the SDK reports that as this error.
const isSessionExpired = (err: unknown): boolean => err instanceof StreamableHTTPError && err.code === 404;

// A JSON-RPC error that the upstream ANSWERED (e.g. "invalid arguments", "unknown tool") proves the
// upstream is alive and working, so it must not count against the circuit breaker. Timeouts and
// "connection closed" are the McpError codes that mean the opposite.
const isAnswerFromLiveServer = (err: unknown): err is McpError =>
  err instanceof McpError && err.code !== ErrorCode.RequestTimeout && err.code !== ErrorCode.ConnectionClosed;

const MAX_ERROR_LENGTH = 300;

// Turns whatever went wrong into one readable sentence for last_error and for MCP clients.
// It is built from error messages only, never from the credential or the request headers.
function describeError(err: unknown): string {
  let text: string;
  if (err instanceof StreamableHTTPError) {
    text = `HTTP ${err.code}: ${err.message}`;
  } else if (err instanceof Error) {
    // Node's fetch hides the useful part (ECONNREFUSED, ENOTFOUND...) in `cause`.
    const code = (err as { cause?: { code?: string } }).cause?.code;
    text = code ? `${err.message} (${code})` : err.message;
  } else {
    text = String(err);
  }
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}...` : text;
}

async function listAllTools(client: Client, signal: AbortSignal): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined, { signal });
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/**
 * One upstream MCP server: its client connection, its tool cache and its circuit breaker.
 *
 * Circuit breaker: every failure (a health check or a real call) adds 1 to a counter, every
 * success resets it to 0. At `failureThreshold` the server is marked "down": its tools disappear
 * from the list and calls fail immediately instead of waiting for a timeout. The health loop keeps
 * probing a down server, and the first successful probe brings it back.
 */
export class Upstream {
  state: UpstreamState = "unknown";
  lastError: string | null = null;

  private failures = 0;
  private downSince: Date | undefined;
  private cache: CachedTool[] = [];
  private clientPromise: Promise<Client> | undefined;
  private refreshing: Promise<void> | undefined;
  private closed = false;

  constructor(
    readonly config: UpstreamConfig,
    private readonly deps: UpstreamDeps,
  ) {}

  /** The tools clients may see (as published, plus the upstream's own name): none unless the server is up. */
  visibleEntries(): { original: string; tool: Tool }[] {
    return this.state === "up" ? this.cache.map((c) => ({ original: c.original, tool: c.tool })) : [];
  }

  /** The upstream's own name for a published tool name, or undefined if we do not have that tool. */
  originalName(published: string): string | undefined {
    return this.cache.find((c) => c.namespaced === published)?.original;
  }

  /**
   * Health check + tool cache refresh (tools/list). Never rejects: failures are recorded instead.
   * If a refresh is already running (a slow server), callers share it rather than piling up another.
   */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  async call(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const { slug, timeoutMs } = this.config;
    // Fail fast: no connection attempt, no waiting for a timeout.
    if (this.state === "down") {
      return fail(
        `Server "${slug}" is unreachable (since ${this.downSince?.toISOString() ?? "unknown"}). ` +
          `Last error: ${this.lastError ?? "unknown"}. Its tools are hidden and calls fail immediately until it answers again.`,
      );
    }
    const entry = this.cache.find((c) => c.namespaced === name);
    if (!entry) {
      const hint = this.state === "unknown" ? " The server has not answered yet." : "";
      return fail(`Server "${slug}" has no tool named "${name}".${hint}`);
    }

    try {
      const result = await this.withClient(`calling ${entry.original}`, timeoutMs, (client, signal) =>
        // `?? {}`: a tool whose inputs are all optional still declares an object, and some servers
        // reject "no arguments at all" for it, so we always send at least an empty object.
        client.callTool({ name: entry.original, arguments: args ?? {} }, undefined, { signal }),
      );
      await this.recordSuccess();
      // The result is passed through untouched, INCLUDING isError results: a tool that reports its
      // own error is a working server.
      return result as CallToolResult;
    } catch (err) {
      if (isAnswerFromLiveServer(err)) {
        await this.recordSuccess();
        return fail(`Server "${slug}" rejected the call to "${entry.original}": ${err.message}`);
      }
      await this.recordFailure(err);
      return fail(
        `Calling "${entry.original}" on server "${slug}" failed: ${describeError(err)}.` +
          (err instanceof UpstreamTimeout
            ? " The operation may still have been carried out upstream; check before retrying."
            : ""),
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.dropClient();
  }

  // ---- internals ----

  private async doRefresh(): Promise<void> {
    try {
      const tools = await this.withClient("listing tools", this.config.timeoutMs, (client, signal) =>
        listAllTools(client, signal),
      );
      this.cache = this.buildCache(tools);
      await this.recordSuccess();
    } catch (err) {
      await this.recordFailure(err);
    }
  }

  private buildCache(tools: Tool[]): CachedTool[] {
    const { slug } = this.config;
    const seen = new Set<string>();
    const cache: CachedTool[] = [];
    for (const tool of tools) {
      const namespaced = namespacedName(slug, tool.name);
      // namespacedName makes this practically impossible; if it ever happens, keep the first and say so.
      if (seen.has(namespaced)) {
        this.deps.logger.warn({ slug, tool: tool.name, namespaced }, "duplicate namespaced tool name, skipping");
        continue;
      }
      seen.add(namespaced);
      cache.push({
        namespaced,
        original: tool.name,
        // Spread keeps everything else the upstream declared (input schema, annotations, title...).
        tool: { ...tool, name: namespaced, description: describeWithSlug(slug, tool.description) },
      });
    }
    return cache;
  }

  // Runs one operation on the client, with a deadline. If the server says our session is gone, it
  // reconnects ONCE and retries; that is not counted as a failure because nothing is actually wrong.
  private async withClient<T>(
    what: string,
    timeoutMs: number,
    run: (client: Client, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.getClient();
        return await withTimeout(timeoutMs, what, (signal) => run(client, signal));
      } catch (err) {
        if (attempt === 0 && isSessionExpired(err)) {
          await this.dropClient();
          continue;
        }
        // After a timeout or a broken connection the client may be wedged: throw it away so the
        // next attempt starts clean. A proper JSON-RPC answer from the server leaves it intact.
        if (!isAnswerFromLiveServer(err)) await this.dropClient();
        throw err;
      }
    }
  }

  // One shared connection attempt: concurrent callers wait for the same promise.
  private getClient(): Promise<Client> {
    if (this.closed) return Promise.reject(new UpstreamError("this server was removed or disabled"));
    if (!this.clientPromise) {
      const attempt = this.connect();
      this.clientPromise = attempt;
      // A failed attempt must not stay cached, or we would never retry.
      attempt.catch(() => {
        if (this.clientPromise === attempt) this.clientPromise = undefined;
      });
    }
    return this.clientPromise;
  }

  private async connect(): Promise<Client> {
    const { url, timeoutMs, slug } = this.config;
    // Checked on EVERY connect, not only at registration: DNS can change after an admin registered the URL.
    await assertUrlAllowed(url, this.deps.ssrf);

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: this.authHeaders() },
    });
    const client = new Client({ name: "mcp-gateway", version: "0.1.0" });
    client.onerror = (err) => this.deps.logger.debug({ slug, err: describeError(err) }, "upstream client error");
    try {
      await withTimeout(timeoutMs, "connecting", (signal) => client.connect(transport, { signal }));
    } catch (err) {
      await client.close().catch(() => undefined); // do not leak a half-open connection
      throw err;
    }
    return client;
  }

  private authHeaders(): Record<string, string> {
    const { authType, credentialEnc } = this.config;
    if (authType === "none") return {};
    if (!credentialEnc) throw new UpstreamError("this server uses bearer auth but has no stored credential");
    try {
      return { Authorization: `Bearer ${decryptCredential(this.deps.credentialKey, credentialEnc)}` };
    } catch {
      // Deliberately no details from the underlying error: keep anything secret-adjacent out of messages.
      throw new UpstreamError("the stored credential could not be decrypted (was CREDENTIAL_ENC_KEY changed?)");
    }
  }

  private async dropClient(): Promise<void> {
    const pending = this.clientPromise;
    this.clientPromise = undefined;
    if (!pending) return;
    try {
      await (await pending).close();
    } catch {
      // Already closed or never connected: nothing to clean up.
    }
  }

  private async recordSuccess(): Promise<void> {
    this.failures = 0;
    const stateChanged = this.state !== "up";
    if (!stateChanged && this.lastError === null) return; // the common case: nothing to store
    if (this.state === "down") this.deps.logger.info({ slug: this.config.slug }, "upstream recovered");
    this.state = "up";
    this.lastError = null;
    this.downSince = undefined;
    await this.emit(stateChanged);
  }

  private async recordFailure(err: unknown): Promise<void> {
    this.failures += 1;
    const message = describeError(err);
    const errorChanged = this.lastError !== message;
    this.lastError = message;

    let stateChanged = false;
    if (this.failures >= this.deps.failureThreshold && this.state !== "down") {
      this.state = "down";
      this.downSince = new Date();
      this.cache = []; // tools are hidden, and a stale cache must not come back as if it were fresh
      stateChanged = true;
      this.deps.logger.warn({ slug: this.config.slug, error: message }, "upstream unreachable");
    }
    if (stateChanged || errorChanged) await this.emit(stateChanged);
  }

  private async emit(stateChanged: boolean): Promise<void> {
    if (this.closed) return; // a removed server must not write its last words over the database
    await this.deps.onChange({ id: this.config.id, state: this.state, lastError: this.lastError, stateChanged });
  }
}
