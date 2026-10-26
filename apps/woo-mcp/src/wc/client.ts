// Talks to the store over its REST API (/wp-json/...), authenticated as the shop_manager user
// with an Application Password. Why REST: it is WooCommerce's public, versioned contract; it
// enforces WooCommerce's own rules (stock, SKU uniqueness, status transitions); and it needs
// nothing shared with the store pod (no volume, no database access, no exec).

export class WcApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when there was no HTTP answer at all (timeout, connection refused). */
    readonly status: number,
    /** WordPress/WooCommerce error code such as "woocommerce_rest_shop_order_invalid_id". */
    readonly code?: string,
  ) {
    super(message);
    this.name = "WcApiError";
  }
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface WcClientOptions {
  baseUrl: string;
  username: string;
  appPassword: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch; // replaced by a fake store in tests
}

function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // Node's fetch reports every network failure as "fetch failed"; the useful part is in `cause`.
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${err.message} (${detail})` : err.message;
}

export class WcClient {
  private readonly base: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WcClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.authorization = "Basic " + Buffer.from(`${opts.username}:${opts.appPassword}`).toString("base64");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** `path` is relative to /wp-json, e.g. "/wc/v3/products" (or "/" for the site index). */
  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, query);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, undefined, body);
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, undefined, body);
  }

  private async request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const url = new URL(`${this.base}/wp-json${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let status: number;
    let ok: boolean;
    let text: string;
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: this.authorization,
          // WordPress only honours Application Passwords on HTTPS requests. In-cluster traffic is
          // plain HTTP, so we say "https" and the store's wp-config trusts this header.
          // See charts/store/README.md, section "REST auth over internal HTTP".
          "X-Forwarded-Proto": "https",
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // One deadline for the whole exchange, including reading the body.
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      status = res.status;
      ok = res.ok;
      text = await res.text();
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new WcApiError(`no answer from the store within ${this.opts.timeoutMs} ms`, 0, "timeout");
      }
      throw new WcApiError(describeNetworkError(err), 0, "unreachable");
    }

    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }

    if (!ok) {
      const e = json as { code?: unknown; message?: unknown } | undefined;
      throw new WcApiError(
        typeof e?.message === "string" ? e.message : `HTTP ${status}`,
        status,
        typeof e?.code === "string" ? e.code : undefined,
      );
    }
    if (json === undefined) {
      // e.g. a 200 with an HTML page: the REST route was not matched (pretty permalinks off?).
      throw new WcApiError(
        "the store answered with something that is not JSON (is the REST API reachable and are pretty permalinks enabled?)",
        status,
        "invalid_response",
      );
    }
    return json as T;
  }
}
