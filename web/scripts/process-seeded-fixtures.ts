// Post-hoc fixture-processing script. Use it when the seed itself
// skipped processing (typically because `npm run dev` wasn't up
// when `npm run db:reseed` ran):
//
//   # one terminal
//   npm run dev
//   # another terminal, after the dev server is reachable
//   npm run db:process-fixtures
//
// The seed already prints the same hint when it skips, so the dev
// almost never has to remember the command name on their own.
//
// Mints a fresh PAT for the dev user — the seed-time PAT is shown
// once and hashed, so we can't reuse it. The minted token is
// labelled `db:process-fixtures` and lives until the next reseed
// truncates the table; the row is otherwise harmless because every
// PAT is hashed at rest.

// biome-ignore lint/performance/noNamespaceImport: drizzle scripts need the full schema module for Db typing
import * as schema from "@/lib/db/schema";
import { generateToken, getTokenPrefix, hashToken } from "@/lib/tokens";
import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { assertLocalDatabaseUrl } from "./assert-local-db";
import { processSeededFixtures } from "./process-fixtures";

const databaseUrl = assertLocalDatabaseUrl("db:process-fixtures");

const client = postgres(databaseUrl);
const db = drizzle(client, { schema });

try {
  // Find the seeded dev user. We look up by email rather than by
  // UUID because the seed regenerates UUIDs on every reseed, but
  // `dev@local` is the stable identifier the seed prints at the
  // end. If the dev has manually changed it, fall back to the first
  // admin row — better than failing.
  const [devUser] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "dev@local"))
    .limit(1);

  if (!devUser) {
    console.error(
      "db:process-fixtures: could not find dev@local user. Run `npm run db:seed` first."
    );
    process.exit(1);
  }

  // Mint a fresh PAT. Wildcard scope mirrors the seed's behavior so
  // every authorize() check this token hits during fixture
  // processing succeeds.
  const plaintext = generateToken();
  await db.insert(schema.personalAccessTokens).values({
    userId: devUser.id,
    name: "db:process-fixtures",
    tokenHash: hashToken(plaintext),
    tokenPrefix: getTokenPrefix(plaintext),
    scopes: ["*"],
    expiresAt: null,
  });

  const result = await processSeededFixtures(db, { apiKey: plaintext });

  if (result.skipped) {
    process.exit(result.skipReason === "api-down" ? 1 : 0);
  }

  if (result.failed > 0) {
    process.exit(1);
  }
} finally {
  await client.end();
}
