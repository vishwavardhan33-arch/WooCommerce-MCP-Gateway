import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { hmacSha256Hex, randomToken } from "./tokens.js";
import type { AuthUser } from "./types.js";

export const SESSION_COOKIE = "session";

// Server-side sessions: the cookie holds a random token and the database holds its keyed hash.
// Unlike a signed-cookie-only design, deleting the row logs the user out immediately.
export async function createSession(
  db: Db,
  secret: string,
  userId: string,
  ttlHours: number,
): Promise<{ token: string }> {
  const token = randomToken();
  await db.insert(sessions).values({
    userId,
    tokenHash: hmacSha256Hex(secret, token),
    expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
  });
  return { token };
}

// Returns the logged-in user, or undefined when the token is unknown or the session has expired.
// Expiry is compared with the DATABASE clock (now()), the same clock for every replica.
export async function findSessionUser(db: Db, secret: string, token: string): Promise<AuthUser | undefined> {
  const rows = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hmacSha256Hex(secret, token)), gt(sessions.expiresAt, sql`now()`)))
    .limit(1);
  return rows[0];
}

export async function deleteSession(db: Db, secret: string, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hmacSha256Hex(secret, token)));
}
