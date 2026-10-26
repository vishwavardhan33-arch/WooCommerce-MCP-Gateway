import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { apiKeys, users, type Role } from "../db/schema.js";
import { HttpError } from "../http.js";
import { API_KEY_TAG, generateApiKey, hashApiKey } from "./tokens.js";
import type { AuthUser } from "./types.js";

// Creates a key for `userId`. The full key is returned here and NEVER again: only its hash is stored.
export async function createApiKey(db: Db, userId: string, name: string) {
  const { key, keyPrefix, keyHash } = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({ userId, name, keyPrefix, keyHash })
    .returning({ id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix, createdAt: apiKeys.createdAt });
  return { apiKey: row, key };
}

// Never selects key_hash: the list is for humans, and the hash has no use outside the database.
export async function listApiKeys(db: Db, userId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));
}

// Owners can revoke their own keys; admins can revoke anyone's (the leaked-key emergency).
// "Not yours" answers 404, the same as "does not exist", so keys of other people cannot be probed.
export async function revokeApiKey(db: Db, actor: AuthUser, keyId: string): Promise<void> {
  const rows = await db.select({ userId: apiKeys.userId }).from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
  const key = rows[0];
  if (!key || (key.userId !== actor.id && actor.role !== "admin")) throw new HttpError(404, "API key not found");

  // WHERE revoked_at IS NULL: revoking twice keeps the ORIGINAL revocation time.
  await db
    .update(apiKeys)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)));
}

// What the gateway's /mcp endpoint will call for every request that carries a key.
// Returns who the key belongs to, or undefined if the key is unknown OR revoked. Revocation takes
// effect on the very next request because every request checks the database.
export async function authenticateApiKey(
  db: Db,
  rawKey: string,
): Promise<{ keyId: string; userId: string; role: Role } | undefined> {
  // Cheap reject before touching the database.
  if (!rawKey.startsWith(API_KEY_TAG)) return undefined;

  // We look the key up BY its hash (unique index) instead of comparing hashes ourselves, so there is
  // no secret-dependent comparison to leak timing: the database either finds the hash or it doesn't.
  const rows = await db
    .select({ keyId: apiKeys.id, userId: users.id, role: users.role })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(and(eq(apiKeys.keyHash, hashApiKey(rawKey)), isNull(apiKeys.revokedAt)))
    .limit(1);
  const found = rows[0];
  if (!found) return undefined;

  // last_used_at is for humans ("is this key still in use?"), so minute precision is plenty. Writing
  // it only when it is empty or older than a minute spares the database one UPDATE per request,
  // and an MCP conversation makes several requests per second.
  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(apiKeys.id, found.keyId),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, sql`now() - interval '1 minute'`)),
      ),
    );
  return found;
}
