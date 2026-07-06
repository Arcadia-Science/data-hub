import "dotenv/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { assertLocalDatabaseUrl } from "./assert-local-db";

const databaseUrl = assertLocalDatabaseUrl("db:reset");

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle(pool);

console.log("Dropping public schema…");
await db.execute(sql`DROP SCHEMA public CASCADE`);
await db.execute(sql`CREATE SCHEMA public`);
// Recreate the pg_trgm extension dropped with the public schema. The trigram
// GIN indexes in schema.ts reference `gin_trgm_ops`, so the extension must
// exist before the subsequent `db:push`. Migration 0029 handles this for the
// `db:migrate` path; push does not run migrations, hence this line.
await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
console.log("Database reset. Run `npm run db:push` to re-create tables.");

await pool.end();
