import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema.js";

// The type every query function accepts. It is the generic Postgres database, not the
// node-postgres one, so the SAME functions run in production (node-postgres, a real server) and in
// tests (PGlite, an in-memory Postgres) and inside transactions. `any` is the driver-specific
// "query result" type that we deliberately do not care about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
export type Db = PgDatabase<any, typeof schema>;

export type NodeDb = NodePgDatabase<typeof schema>;

export function createDb(connectionString: string): { db: NodeDb; pool: pg.Pool } {
  // A Pool keeps a few connections open and reuses them, instead of connecting per request.
  const pool = new pg.Pool({ connectionString });
  return { db: drizzle({ client: pool, schema }), pool };
}
