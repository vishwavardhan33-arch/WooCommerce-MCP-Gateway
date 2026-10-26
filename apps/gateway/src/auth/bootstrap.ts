import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { hashPassword } from "./password.js";

// Chicken-and-egg: inviting people needs an admin, and the first admin needs something other than
// an invite. So on start, IF no admin exists, create one from environment variables. Once an admin
// exists this does nothing, so changing the env password later does NOT reset a real admin's
// password (use the normal flows for that).
export async function bootstrapAdmin(
  db: Db,
  admin: { email: string; password: string },
  logger: Logger,
): Promise<void> {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  if (existing.length > 0) return;

  const passwordHash = await hashPassword(admin.password);
  // ON CONFLICT DO NOTHING: if two replicas start together and both get here, the database lets
  // exactly one insert win and the other simply inserts nothing, instead of crashing.
  const created = await db
    .insert(users)
    .values({ email: admin.email, passwordHash, role: "admin" })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });

  if (created.length > 0) logger.info({ email: admin.email }, "bootstrap admin created");
  else logger.warn("bootstrap admin skipped: a user with that email already exists");
}
