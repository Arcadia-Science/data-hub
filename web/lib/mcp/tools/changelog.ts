import type { McpServer } from "@modelcontextprotocol/server";
import { appOrigin } from "@/lib/app-origin";
import { changelogEntryPath } from "@/lib/changelog/href";
import { isRealCalendarDate } from "@/lib/changelog/parse";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import { changelogSpan, searchChangelog } from "@/lib/mcp/changelog/search";
import { errorResult, structuredResult } from "@/lib/mcp/tools/helpers";
import { MIN_QUERY_LENGTH } from "@/lib/search-constants";
import { DEFAULT_LIMIT, searchChangelogTool } from "./changelog.defs";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayError(name: string, value: string | undefined): string | null {
  if (value === undefined || (DAY.test(value) && isRealCalendarDate(value))) {
    return null;
  }
  return `${name} must be a real date written YYYY-MM-DD, such as 2026-10-01. Got '${value}'.`;
}

function describeRange(dateFrom?: string, dateTo?: string): string {
  if (dateFrom && dateTo) {
    return dateFrom === dateTo
      ? ` on ${dateFrom}`
      : ` from ${dateFrom} to ${dateTo}`;
  }
  if (dateFrom) {
    return ` on or after ${dateFrom}`;
  }
  if (dateTo) {
    return ` on or before ${dateTo}`;
  }
  return "";
}

function missingWordsNote(missingWords: readonly string[]): string {
  return missingWords.length > 0
    ? `The changelog never mentions ${missingWords.map((word) => `'${word}'`).join(", ")}. `
    : "";
}

export function registerChangelogTools(server: McpServer) {
  server.registerTool(
    searchChangelogTool.name,
    toolRegistrationConfig(searchChangelogTool),
    (args) => {
      const query = args.query?.trim() || undefined;
      const dateFrom = args.dateFrom?.trim() || undefined;
      const dateTo = args.dateTo?.trim() || undefined;

      if (query && query.length < MIN_QUERY_LENGTH) {
        return errorResult(
          `Query must be at least ${MIN_QUERY_LENGTH} characters. Leave it out to list entries by date.`
        );
      }
      const invalid =
        dayError("dateFrom", dateFrom) ?? dayError("dateTo", dateTo);
      if (invalid) {
        return errorResult(invalid);
      }
      if (dateFrom && dateTo && dateFrom > dateTo) {
        return errorResult(`dateFrom (${dateFrom}) is after dateTo (${dateTo}).`);
      }

      const { entries, goodMatches, missingWords, total } = searchChangelog({
        query,
        dateFrom,
        dateTo,
        limit: args.limit ?? DEFAULT_LIMIT,
      });
      const span = changelogSpan();

      let hint: string | undefined;
      if (total === 0) {
        hint = `No changelog entry matches${describeRange(dateFrom, dateTo)}. ${missingWordsNote(missingWords)}${
          span
            ? `The changelog runs from ${span.oldest} to ${span.newest}.`
            : "The changelog has no entries."
        }${query ? " To list changes by date instead, leave out query and pass dateFrom and dateTo." : ""}`;
      } else if (goodMatches === 0 && span) {
        hint = `${missingWordsNote(missingWords)}No entry clearly matches the question, so these may not answer it. The changelog starts on ${span.oldest}; changes from before then, and changes that were never written up, are not in it.`;
      }

      const origin = appOrigin();
      return structuredResult({
        entries: entries.map((entry) => ({
          id: entry.id,
          title: entry.title,
          date: entry.date,
          markdown: entry.body,
          url: `${origin}${changelogEntryPath(entry.id)}`,
          docsUrl: entry.docs ?? null,
        })),
        total,
        ...(hint ? { hint } : {}),
      });
    }
  );
}
