import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { personalAccessTokens } from "@/lib/db/schema";

// A personal access token as a response names it: `{ id, name }`, the way the
// runs API names the token that deleted a run.
export interface TokenRef {
  id: string;
  name: string;
}

/**
 * The tokens behind a list of `files.deleted_by_token` values, by id. A file row
 * keeps only the token's ID, so a response that names the deleter looks the
 * names up in one query. Missing and null IDs are skipped.
 */
export async function loadTokenRefs(
  tokenIds: ReadonlyArray<string | null | undefined>
): Promise<Map<string, TokenRef>> {
  const unique = [
    ...new Set(tokenIds.filter((id): id is string => typeof id === "string")),
  ];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: personalAccessTokens.id, name: personalAccessTokens.name })
    .from(personalAccessTokens)
    .where(inArray(personalAccessTokens.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

// The token for an ID read from a file row, or null for no token. A token row is
// never removed (the column references it with `restrict`), so the fallback
// name is only a guard. It is the one `resolveActor` gives.
export function tokenRefFor(
  tokens: ReadonlyMap<string, TokenRef>,
  tokenId: string | null
): TokenRef | null {
  if (tokenId === null) {
    return null;
  }
  return tokens.get(tokenId) ?? { id: tokenId, name: "Unknown token" };
}
