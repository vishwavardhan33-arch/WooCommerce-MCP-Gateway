import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { pino } from "pino";
import { loadConfig } from "../config.js";
import { MIGRATIONS_FOLDER } from "../db/migrate.js";
import * as schema from "../db/schema.js";
import { users, type Role } from "../db/schema.js";
import { hashPassword } from "../auth/password.js";
import type { Db } from "../db/client.js";

// PGlite is a real Postgres compiled to WebAssembly, running inside the test process: no Docker, no
// server, nothing to install, and it applies the SAME migration files production uses. So the tests
// also prove that the SQL in ./drizzle is valid and creates what the code expects.
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite(); // no argument = in memory, gone when the test file ends
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, close: () => client.close() };
}

// Built through loadConfig so the tests also use the real validation rules.
export const testConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({
    DATABASE_URL: "postgres://unused:unused@localhost:5432/unused", // never connected to: tests use PGlite
    SESSION_SECRET: "test-session-secret-0123456789abcdef",
    ADMIN_BOOTSTRAP_EMAIL: "admin@example.com",
    ADMIN_BOOTSTRAP_PASSWORD: "correct-horse-battery",
    PUBLIC_BASE_URL: "http://app.test",
    COOKIE_SECURE: "false",
    CREDENTIAL_ENC_KEY: "0123456789abcdef".repeat(4),
    ...overrides,
  });

export const silentLogger = pino({ level: "silent" });

// Inserts a user directly. Pass a password only when the test logs in (argon2 is deliberately
// slow); otherwise a placeholder hash keeps the test fast.
export async function seedUser(db: Db, email: string, role: Role, password?: string) {
  const passwordHash = password ? await hashPassword(password) : "not-a-real-hash";
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash, role })
    .returning({ id: users.id, email: users.email, role: users.role });
  return user;
}
