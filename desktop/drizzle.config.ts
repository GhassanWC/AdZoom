import { defineConfig } from "drizzle-kit";

/**
 * Migration generation only (`npm run db:generate`). The app itself opens the
 * database through node:sqlite (see src/main/db/client.ts) and applies the
 * generated SQL with its own tiny runner — drizzle-kit is a build-time tool
 * here, never shipped in the installer.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/main/db/schema.ts",
  out: "./src/main/db/migrations",
});
