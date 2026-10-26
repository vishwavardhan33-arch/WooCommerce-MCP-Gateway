import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { invites, users, type Role } from "../db/schema.js";
import { HttpError } from "../http.js";
import { hashPassword } from "./password.js";
import { randomToken, sha256Hex } from "./tokens.js";
import type { AuthUser } from "./types.js";

// Creates an invite and returns the raw token ONCE. Only its sha256 is stored, so nobody who reads
// the database can build a working link.
export async function createInvite(
  db: Db,
  admin: AuthUser,
  input: { email: string; role: Role },
  ttlHours: number,
) {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
  if (existing.length > 0) throw new HttpError(409, "A user with that email already exists");

  const token = randomToken();
  const [invite] = await db
    .insert(invites)
    .values({
      email: input.email,
      role: input.role,
      tokenHash: sha256Hex(token),
      createdBy: admin.id,
      expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
    })
    .returning({ id: invites.id, email: invites.email, role: invites.role, expiresAt: invites.expiresAt });
  return { invite, token };
}

// Turns an invite into a user. "One-time" is enforced by the database, not by our code's good manners:
// the UPDATE ... WHERE used_at IS NULL claims the invite atomically, so if two requests race with
// the same link exactly one gets a row back.
export async function acceptInvite(db: Db, token: string, password: string): Promise<AuthUser> {
  // Hash BEFORE opening the transaction: it is slow CPU work and should not hold a database
  // transaction (and its locks) open while it runs.
  const passwordHash = await hashPassword(password);

  return db.transaction(async (tx) => {
    const [invite] = await tx
      .update(invites)
      .set({ usedAt: sql`now()` })
      .where(and(eq(invites.tokenHash, sha256Hex(token)), isNull(invites.usedAt), gt(invites.expiresAt, sql`now()`)))
      .returning();
    // Unknown, used and expired all get the same answer: do not help someone probing tokens.
    if (!invite) throw new HttpError(400, "This invite link is invalid, already used, or expired");

    const [user] = await tx
      .insert(users)
      .values({ email: invite.email, passwordHash, role: invite.role })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id, email: users.email, role: users.role });
    // Throwing inside the transaction rolls it back, so the invite is NOT consumed by a failed accept.
    if (!user) throw new HttpError(409, "A user with that email already exists");
    return user;
  });
}
