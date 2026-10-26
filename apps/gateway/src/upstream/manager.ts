import { eq, sql } from "drizzle-orm";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { SLUG_PATTERN, slugOf } from "./namespacing.js";
import { fail } from "./result.js";
import type { SsrfOptions } from "./ssrf.js";
import { Upstream, type StatusEvent } from "./upstream.js";

/** One published tool plus where it came from: what permission checks and audit records need. */
export interface ToolEntry {
  slug: string;
  serverId: string;
  /** The upstream's own tool name (policies and audit use this, not the namespaced one). */
  original: string;
  tool: Tool;
}

export interface ManagerOptions {
  db: Db;
  logger: Logger;
  credentialKey: Buffer;
  allowedHosts: string[];
  /** Replaceable in tests so they need no real DNS. */
  lookup?: SsrfOptions["lookup"];
  healthIntervalMs?: number;
  failureThreshold?: number;
}

/**
 * Owns one Upstream per ENABLED row of mcp_servers and presents them to clients as one tool list.
 *
 * Design rule: listing and calling never wait for a slow server to be probed. Probing happens in the
 * background loop; listTools() only reads what the loop already cached.
 */
export class UpstreamManager {
  private readonly upstreams = new Map<string, Upstream>(); // key: slug
  private readonly signatures = new Map<string, string>(); // slug -> what the running Upstream was built from
  private readonly warnedInvalid = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  private readonly db: Db;
  private readonly logger: Logger;
  private readonly credentialKey: Buffer;
  private readonly ssrf: SsrfOptions;
  private readonly healthIntervalMs: number;
  private readonly failureThreshold: number;

  constructor(opts: ManagerOptions) {
    this.db = opts.db;
    this.logger = opts.logger;
    this.credentialKey = opts.credentialKey;
    this.ssrf = { allowedHosts: opts.allowedHosts, lookup: opts.lookup };
    this.healthIntervalMs = opts.healthIntervalMs ?? 10_000;
    this.failureThreshold = opts.failureThreshold ?? 2;
  }

  /** Loads the servers, starts probing them right away, and keeps probing every interval. */
  async start(): Promise<void> {
    await this.sync();
    void this.refreshAll(); // not awaited: startup must not wait for slow servers
    this.timer = setInterval(() => {
      this.tick().catch((err: unknown) => this.logger.error({ err }, "health loop iteration failed"));
    }, this.healthIntervalMs);
    this.timer.unref(); // the HTTP server keeps the process alive; this timer alone must not
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.upstreams.values()].map((u) => u.close()));
    this.upstreams.clear();
    this.signatures.clear();
  }

  /** One loop iteration: pick up database changes, then probe every server. Public so tests can drive it. */
  async tick(): Promise<void> {
    await this.sync();
    await this.refreshAll();
  }

  /**
   * Probes every server AT THE SAME TIME. allSettled waits for all of them whatever happens, so one
   * server that hangs or fails cannot stop the others from being refreshed (Promise.all would reject
   * on the first failure). Each probe is bounded by that server's own timeout.
   */
  refreshAll(): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled([...this.upstreams.values()].map((u) => u.refresh()));
  }

  /** Every visible tool of every healthy server, straight from the cache: no network, no waiting. */
  listEntries(): ToolEntry[] {
    return [...this.upstreams.values()].flatMap((u) =>
      u.visibleEntries().map((e) => ({ slug: u.config.slug, serverId: u.config.id, original: e.original, tool: e.tool })),
    );
  }

  listTools(): Tool[] {
    return this.listEntries().map((e) => e.tool);
  }

  /**
   * Which server and upstream tool a published name refers to, WITHOUT calling anything.
   * undefined = no such server. `original` is undefined when the server exists but the tool is not
   * in its cache (unknown tool, or the server is down and its cache is empty).
   */
  locate(name: string): { slug: string; serverId: string; original: string | undefined } | undefined {
    const slug = slugOf(name);
    const upstream = slug === undefined ? undefined : this.upstreams.get(slug);
    if (!upstream) return undefined;
    return { slug: upstream.config.slug, serverId: upstream.config.id, original: upstream.originalName(name) };
  }

  /** Never throws: every problem comes back as an isError result with a message the client can act on. */
  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    const slug = slugOf(name);
    const upstream = slug === undefined ? undefined : this.upstreams.get(slug);
    if (!upstream) {
      const known = [...this.upstreams.keys()];
      return fail(
        `Unknown tool "${name}". Tool names look like <server>__<tool>. ` +
          (known.length > 0 ? `Known servers: ${known.join(", ")}.` : "No servers are registered."),
      );
    }
    return upstream.call(name, args);
  }

  // Makes the running Upstreams match the mcp_servers table: new rows start, disabled or deleted
  // rows stop, and a row whose url / auth / timeout changed is rebuilt from scratch.
  private async sync(): Promise<void> {
    const rows = await this.db.select().from(mcpServers).where(eq(mcpServers.enabled, true));

    const wanted = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!SLUG_PATTERN.test(row.slug)) {
        // A slug with "__" or odd characters would break routing, so such a server is not started.
        if (!this.warnedInvalid.has(row.id)) {
          this.warnedInvalid.add(row.id);
          this.logger.warn({ slug: row.slug }, "mcp server skipped: slug must start with a letter and use only lower-case letters, digits and single hyphens");
        }
        continue;
      }
      wanted.set(row.slug, row);
    }

    for (const [slug, upstream] of this.upstreams) {
      const row = wanted.get(slug);
      if (row && this.signatureOf(row) === this.signatures.get(slug)) continue;
      this.upstreams.delete(slug);
      this.signatures.delete(slug);
      await upstream.close();
      // No longer served: reset its stored status instead of leaving a stale "up".
      await this.persist({ id: upstream.config.id, state: "unknown", lastError: null, stateChanged: true });
    }

    for (const [slug, row] of wanted) {
      if (this.upstreams.has(slug)) continue;
      this.upstreams.set(
        slug,
        new Upstream(
          { id: row.id, slug, url: row.url, authType: row.authType, credentialEnc: row.credentialEnc, timeoutMs: row.timeoutMs },
          {
            logger: this.logger,
            credentialKey: this.credentialKey,
            ssrf: this.ssrf,
            failureThreshold: this.failureThreshold,
            onChange: (event) => this.persist(event),
          },
        ),
      );
      this.signatures.set(slug, this.signatureOf(row));
    }
  }

  private signatureOf(row: { id: string; url: string; authType: string; credentialEnc: string | null; timeoutMs: number }): string {
    return JSON.stringify([row.id, row.url, row.authType, row.credentialEnc, row.timeoutMs]);
  }

  // Stores health in mcp_servers. status_since only moves when the status CHANGES, so it answers
  // "how long has it been down?". A database hiccup is logged and swallowed: it must not break probing.
  private async persist(event: StatusEvent): Promise<void> {
    try {
      await this.db
        .update(mcpServers)
        .set({
          lastError: event.lastError,
          ...(event.stateChanged ? { status: event.state, statusSince: sql`now()` } : {}),
        })
        .where(eq(mcpServers.id, event.id));
    } catch (err) {
      this.logger.error({ err, serverId: event.id }, "could not store upstream status");
    }
  }
}
