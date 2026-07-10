import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
// biome-ignore lint/performance/noNamespaceImport: drizzle expects the full schema module for relational query support
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Managed Postgres (Render) requires TLS over the public endpoint, but the
// local dev/test cluster on 127.0.0.1 speaks plaintext. Unlike postgres.js,
// `pg` does not auto-negotiate TLS, so we opt in explicitly for non-local
// hosts. `rejectUnauthorized: false` because the provider's cert chain isn't
// in the system trust store and we're already pinned to the host by URL.
function requiresSsl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname !== "localhost" && hostname !== "127.0.0.1";
  } catch {
    return false;
  }
}

const globalForDb = globalThis as unknown as { dbPool?: Pool };
if (!globalForDb.dbPool) {
  const pool = new Pool({
    connectionString,
    // Keep idle connections short-lived: on Fluid the idle timer is frozen
    // while an instance is suspended, so a long-lived idle socket is exactly
    // what Render/network silently closes, producing CONNECTION_CLOSED on the
    // next query. A low value plus `attachDatabasePool` keeps reuse safe.
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
    ssl: requiresSsl(connectionString) ? { rejectUnauthorized: false } : false,
  });
  // Fluid lifecycle hook: keeps the instance alive via `waitUntil` long enough
  // to drain idle connections before suspension, so we never resume onto a
  // dead socket. No-op outside Vercel. Must run once per instance.
  attachDatabasePool(pool);
  globalForDb.dbPool = pool;
}

export const db = drizzle(globalForDb.dbPool, { schema });

// Either the pooled `db` or a transaction handle. Functions that accept this
// can run standalone or enlist in a caller's `db.transaction(...)`.
export type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];
