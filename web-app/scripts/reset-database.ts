import "dotenv/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const client = postgres(process.env.DATABASE_URL!);
const db = drizzle(client);

console.log("Dropping public schema…");
await db.execute(sql`DROP SCHEMA public CASCADE`);
await db.execute(sql`CREATE SCHEMA public`);
console.log("Database reset. Run `npm run db:push` to re-create tables.");

await client.end();
