import { z } from "zod";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import { readDocOutputSchema, searchDocsOutputSchema } from "./docs.output";

export const searchDocsTool = {
  name: "search_docs",
  title: "Search Docs",
  description:
    "Search Data Hub's own documentation and changelog. Use it for how-to and explanation questions about Data Hub itself: setting up instruments and watchers, tokens, permissions, notifications, MCP and API access, and what changed recently. Returns up to five matching sections, each with a short excerpt, a page ID, and a link to cite. Call read_doc to read the full page or section. Not for lab data; use global_search or search_runs for runs, files, and instruments. When nothing matches, the result lists every docs page so you can pick one. If the results do not answer the question, say the docs do not cover it and offer to report the gap with send_feedback.",
  group: "docs",
  inputSchema: {
    query: z
      .string()
      .describe(
        "What to look up, as a question or keywords (min 2 characters)."
      ),
  },
  outputSchema: searchDocsOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const readDocTool = {
  name: "read_doc",
  title: "Read Doc",
  description:
    "Read one page of Data Hub's documentation, or one changelog entry, as Markdown. Pass a page ID from search_docs, such as `manage-tokens` or `changelog/2026-10-08-hina-large-image-previews`. Add `section` (a heading ID from the search result) to read only that part. The result lists the page's section IDs, so a long page can be read in pieces. Cite the returned link in your answer.",
  group: "docs",
  inputSchema: {
    page: z
      .string()
      .describe(
        "Page ID from search_docs. A docs path or URL such as /docs/manage-tokens is also accepted."
      ),
    section: z
      .string()
      .optional()
      .describe("Heading ID within the page. Omit to read the whole page."),
  },
  outputSchema: readDocOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const DOCS_TOOL_DEFS = [searchDocsTool, readDocTool] as const;
