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
console.log("Database reset. Run `npm run db:push` to re-create tables.");

await pool.end();
