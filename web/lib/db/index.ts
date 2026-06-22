import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const globalForDb = globalThis as unknown as {
  dbClient: ReturnType<typeof postgres>;
};
globalForDb.dbClient ??= postgres(connectionString);
const client = globalForDb.dbClient;

export const db = drizzle(client, { schema });
