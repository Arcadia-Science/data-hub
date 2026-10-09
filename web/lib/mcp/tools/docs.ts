import type { McpServer } from "@modelcontextprotocol/server";
import { appOrigin } from "@/lib/app-origin";
import { DOCS_URL } from "@/lib/docs";
import { trackDocsRead, trackDocsSearch } from "@/lib/mcp/analytics";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import {
  type DocEntry,
  findDoc,
  listDocPages,
  parseDocRef,
  unknownPageMessage,
} from "@/lib/mcp/docs/bundle";
import { searchDocs } from "@/lib/mcp/docs/search";
import { errorResult, structuredResult } from "@/lib/mcp/tools/helpers";
import { MIN_QUERY_LENGTH } from "@/lib/search-constants";
import { readDocTool, searchDocsTool } from "./docs.defs";

const REPORT_GAP =
  "If the docs do not cover the question, say so and offer to report the gap with send_feedback.";

const NO_MATCH_HINT = `Nothing matched. Pick a page from \`pages\` and call read_doc, or try different words. ${REPORT_GAP}`;

function weakMatchHint(missingWords: readonly string[]): string {
  const missing =
    missingWords.length > 0
      ? `The docs never mention ${missingWords.map((word) => `'${word}'`).join(", ")}. `
      : "";
  return `${missing}No section matches most of the question, so these results may not answer it. ${REPORT_GAP}`;
}

// `DOCS_URL` is path-only when the docs share the app's origin, and an agent
// needs a link it can hand to a person.
function docsBaseUrl(): string {
  return DOCS_URL.startsWith("http") ? DOCS_URL : `${appOrigin()}${DOCS_URL}`;
}

function docUrl(entry: DocEntry, sectionId: string | null): string | null {
  if (entry.kind === "changelog") {
    return entry.docsUrl;
  }
  return `${docsBaseUrl()}/${entry.page}${sectionId ? `#${sectionId}` : ""}`;
}

export function registerDocsTools(server: McpServer) {
  server.registerTool(
    searchDocsTool.name,
    toolRegistrationConfig(searchDocsTool),
    ({ query }, ctx) => {
      const trimmed = query.trim();
      if (trimmed.length < MIN_QUERY_LENGTH) {
        return errorResult(
          `Query must be at least ${MIN_QUERY_LENGTH} characters.`
        );
      }

      const { hits, goodMatches, missingWords } = searchDocs(trimmed);
      trackDocsSearch(ctx, goodMatches);

      if (hits.length === 0) {
        return structuredResult({
          results: [],
          pages: listDocPages(),
          hint: NO_MATCH_HINT,
        });
      }
      return structuredResult({
        results: hits.map(({ entry, section, excerpt }) => ({
          page: entry.page,
          title: entry.title,
          section: section?.id ?? null,
          heading: section?.heading ?? null,
          excerpt,
          url: docUrl(entry, section?.id ?? null),
          date: entry.kind === "changelog" ? entry.date : null,
        })),
        ...(goodMatches === 0 ? { hint: weakMatchHint(missingWords) } : {}),
      });
    }
  );

  server.registerTool(
    readDocTool.name,
    toolRegistrationConfig(readDocTool),
    ({ page, section }, ctx) => {
      const ref = parseDocRef(page, section);
      const entry = findDoc(ref.page);
      if (!entry) {
        return errorResult(unknownPageMessage(ref.page));
      }

      const wanted = ref.section?.toLowerCase();
      const match = wanted
        ? entry.sections.find((s) => s.id.toLowerCase() === wanted)
        : undefined;
      if (wanted && !match) {
        const ids = entry.sections.map((s) => s.id).join(", ");
        return errorResult(
          `Page '${entry.page}' has no section '${ref.section}'.${
            ids
              ? ` Sections: ${ids}.`
              : " It has no sections; read the whole page."
          }`
        );
      }

      trackDocsRead(ctx, entry.page);
      return structuredResult({
        page: entry.page,
        title: entry.title,
        section: match?.id ?? null,
        heading: match?.heading ?? null,
        url: docUrl(entry, match?.id ?? null),
        markdown: match ? match.markdown : entry.markdown,
        sections: entry.sections.map(({ id, heading, level }) => ({
          id,
          heading,
          level,
        })),
      });
    }
  );
}
