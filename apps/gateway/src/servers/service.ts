import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import { encryptCredential } from "../crypto.js";
import type { Db } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import { HttpError } from "../http.js";
import { assertUrlAllowed, SsrfError } from "../upstream/ssrf.js";

type Row = typeof mcpServers.$inferSelect;
type AuthType = Row["authType"];

// What the API returns about a server. There is deliberately NO field for the credential, encrypted
// or not: it goes in through create/update and never comes back out. `hasCredential` is all the
// dashboard needs to show "a credential is saved".
export interface ServerDto {
  id: string;
  slug: string;
  url: string;
  authType: AuthType;
  hasCredential: boolean;
  enabled: boolean;
  timeoutMs: number;
  status: Row["status"];
  statusSince: Date;
  /** Only filled in for admins: it can contain internal hostnames and addresses. */
  lastError: string | null;
  toolCount: number;
  createdAt: Date;
}

export function toDto(row: Row, toolCount: number, includeError: boolean): ServerDto {
  return {
    id: row.id,
    slug: row.slug,
    url: row.url,
    authType: row.authType,
    hasCredential: row.credentialEnc !== null,
    enabled: row.enabled,
    timeoutMs: row.timeoutMs,
    status: row.status,
    statusSince: row.statusSince,
    lastError: includeError ? row.lastError : null,
    toolCount,
    createdAt: row.createdAt,
  };
}

const credentialKey = (config: Config) => Buffer.from(config.CREDENTIAL_ENC_KEY, "hex");

// The same SSRF rules the manager applies on every connect, applied here too so a bad URL is refused
// when it is typed in, with a message the admin can act on, instead of surfacing later as "Unreachable".
async function checkUrl(config: Config, url: string): Promise<void> {
  try {
    await assertUrlAllowed(url, { allowedHosts: config.UPSTREAM_ALLOWED_HOSTS });
  } catch (err) {
    if (err instanceof SsrfError) throw new HttpError(400, err.message);
    throw err;
  }
}

export interface CreateServerInput {
  slug: string;
  url: string;
  authType: AuthType;
  credential?: string;
  timeoutMs: number;
  enabled: boolean;
}

export async function createServer(db: Db, config: Config, input: CreateServerInput): Promise<Row> {
  await checkUrl(config, input.url);
  if (input.authType === "bearer" && !input.credential) throw new HttpError(400, "A bearer server needs a credential");
  if (input.authType === "none" && input.credential) throw new HttpError(400, "A credential is only used with bearer auth");

  const [row] = await db
    .insert(mcpServers)
    .values({
      slug: input.slug,
      url: input.url,
      authType: input.authType,
      credentialEnc: input.credential ? encryptCredential(credentialKey(config), input.credential) : null,
      timeoutMs: input.timeoutMs,
      enabled: input.enabled,
    })
    .onConflictDoNothing({ target: mcpServers.slug })
    .returning();
  if (!row) throw new HttpError(409, "A server with this slug already exists");
  return row;
}

export interface UpdateServerInput {
  url?: string;
  authType?: AuthType;
  /** Setting it REPLACES the stored credential. Omit it to keep the current one. */
  credential?: string;
  timeoutMs?: number;
  enabled?: boolean;
}

export async function updateServer(db: Db, config: Config, id: string, patch: UpdateServerInput): Promise<Row> {
  const [current] = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
  if (!current) throw new HttpError(404, "Server not found");

  if (patch.url !== undefined) await checkUrl(config, patch.url);

  const authType = patch.authType ?? current.authType;
  let credentialEnc = current.credentialEnc;
  if (authType === "none") {
    if (patch.credential) throw new HttpError(400, "A credential is only used with bearer auth");
    credentialEnc = null; // switching to "none" must not leave an old credential behind
  } else if (patch.credential) {
    credentialEnc = encryptCredential(credentialKey(config), patch.credential);
  } else if (!credentialEnc) {
    throw new HttpError(400, "A bearer server needs a credential");
  }

  const [row] = await db
    .update(mcpServers)
    .set({
      url: patch.url ?? current.url,
      authType,
      credentialEnc,
      timeoutMs: patch.timeoutMs ?? current.timeoutMs,
      enabled: patch.enabled ?? current.enabled,
    })
    .where(eq(mcpServers.id, id))
    .returning();
  if (!row) throw new HttpError(404, "Server not found");
  return row;
}

export async function deleteServer(db: Db, id: string): Promise<void> {
  const deleted = await db.delete(mcpServers).where(eq(mcpServers.id, id)).returning({ id: mcpServers.id });
  if (deleted.length === 0) throw new HttpError(404, "Server not found");
}
