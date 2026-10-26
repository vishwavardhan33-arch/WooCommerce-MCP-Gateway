import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.js";
import type { Db } from "../db/client.js";
import type { Role } from "../db/schema.js";
import { UpstreamManager } from "../upstream/manager.js";
import { createTestDb, seedUser, silentLogger, testConfig } from "./helpers.js";

export const PASSWORD = "correct-horse-battery";

interface CallOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
}

// The whole gateway app on a random port, over an in-memory Postgres, with a real UpstreamManager.
// 127.0.0.1 is allowlisted (like the manager tests) so mock upstreams on localhost are reachable.
export async function startHarness(overrides: Record<string, string> = {}) {
  const { db, close: closeDb } = await createTestDb();
  const config = testConfig({ UPSTREAM_ALLOWED_HOSTS: "127.0.0.1", ...overrides });
  const upstreams = new UpstreamManager({
    db,
    logger: silentLogger,
    credentialKey: Buffer.from(config.CREDENTIAL_ENC_KEY, "hex"),
    allowedHosts: config.UPSTREAM_ALLOWED_HOSTS,
    healthIntervalMs: 3_600_000, // effectively "never": tests call upstreams.tick() themselves
  });
  const app = createApp({ db, config, logger: silentLogger, upstreams });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = (path: string, { method, body, cookie }: CallOptions = {}) =>
    fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  // Creates a user and logs in; returns the user and the "session=<token>" cookie to send back.
  async function loginAs(email: string, role: Role) {
    const user = await seedUser(db, email, role, PASSWORD);
    const res = await call("/api/auth/login", { body: { email, password: PASSWORD } });
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
    const cookie = (res.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    return { user: user as { id: string; email: string; role: Role }, cookie };
  }

  async function close() {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await upstreams.stop();
    await closeDb();
  }
  return { db: db as Db, config, upstreams, base, call, loginAs, close };
}
