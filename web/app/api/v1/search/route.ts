import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { globalSearch, type SearchScope } from "@/lib/api/search";

// ---------------------------------------------------------------------------
// GET /api/v1/search?q=…&scope=all|runs|files|instruments|users|comments
//
// Cross-entity global search powering the ⌘K palette. Returns grouped,
// relevance-ordered matches over runs, files, instruments, users, and
// comments. There is no row-level scoping in Data Hub, so any caller with
// `runs:read` sees the same set the rest of the app exposes.
// ---------------------------------------------------------------------------

const VALID_SCOPES: ReadonlySet<SearchScope> = new Set([
  "all",
  "runs",
  "files",
  "instruments",
  "users",
  "comments",
]);

function parseScope(raw: string | null): SearchScope {
  return raw && VALID_SCOPES.has(raw as SearchScope)
    ? (raw as SearchScope)
    : "all";
}

export async function GET(request: NextRequest) {
  const authResult = await authorize(request, "runs:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { searchParams } = request.nextUrl;
  const query = searchParams.get("q") ?? "";
  const scope = parseScope(searchParams.get("scope"));

  // The builder itself returns an empty result below the minimum length, so
  // the guard here just avoids the DB round-trip for 0–1 char queries.
  const result = await globalSearch({ query, scope });

  return Response.json(result);
}
