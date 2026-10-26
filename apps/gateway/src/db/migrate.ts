import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { NodeDb } from "./client.js";

// ../../drizzle is right from both src/db (tests) and dist/db (the built image): it is the
// "drizzle" folder next to package.json. Resolved from this file, not from the working directory.
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

// Applies every migration that has not run yet and records it in the drizzle.__drizzle_migrations
// table, so running it again is a no-op. All pending migrations run in ONE transaction: if two
// replicas start at the same moment on an empty database, one of them fails, crashes, and
// Kubernetes restarts it. On the restart everything is already applied. Nothing is half-done.
export async function runMigrations(db: NodeDb): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
