import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { HttpError } from "../http.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { AuthUser } from "./types.js";

// A real argon2 hash of a throwaway password, computed once on first use.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword("not-a-real-password"));

// One message for "no such email" and "wrong password", and the same amount of work for both:
// when the email is unknown we still verify against the dummy hash. Otherwise an attacker could
// tell which emails have accounts by measuring how fast the answer comes back.
export async function login(db: Db, email: string, password: string): Promise<AuthUser> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  const passwordOk = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), password);
  if (!user || !passwordOk) throw new HttpError(401, "Invalid email or password");
  return { id: user.id, email: user.email, role: user.role };
}
