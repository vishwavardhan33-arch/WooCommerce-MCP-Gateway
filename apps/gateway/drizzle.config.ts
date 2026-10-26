// Only used by the drizzle-kit CLI (`npm run db:generate`); the running service never reads it.
// generate compares schema.ts with the previous migration and writes the SQL difference to ./drizzle.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
