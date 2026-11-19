import { z } from "zod";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import {
  NOTEBOOK_LINK_BULK_RUNS_MAX,
  notebookLinkLabelInputSchema,
  notebookLinkUrlSchema,
} from "@/lib/notebook-links/url";
import {
  addNotebookLinkOutputSchema,
  listNotebookLinkNamesOutputSchema,
  removeNotebookLinkOutputSchema,
  updateNotebookLinkOutputSchema,
} from "./notebook-links.output";

const runIds = z
  .array(z.string())
  .min(1)
  .max(NOTEBOOK_LINK_BULK_RUNS_MAX)
  .describe(
    `Run identifiers within the instrument (1–${NOTEBOOK_LINK_BULK_RUNS_MAX})`
  );

export const addNotebookLinkTool = {
  name: "add_notebook_link",
  group: "notebook_links",
  scope: "runs:link",
  title: "Add Notebook Link",
  description: `Link runs on one instrument to a lab notebook page: any http or https page, such as Notion or Google Docs. Adds the same link to up to ${NOTEBOOK_LINK_BULK_RUNS_MAX} runs and reports an outcome for each. Runs that already link to the same page keep their link and label, and deleted or missing runs are skipped. Acts as the signed-in user. Adding a link doesn't record who ran the runs; call claim_runs for that.`,
  outputSchema: addNotebookLinkOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runIds,
    url: notebookLinkUrlSchema.describe(
      "The notebook page's http or https URL"
    ),
    label: notebookLinkLabelInputSchema
      .nullable()
      .optional()
      .describe(
        "Optional short name for the link. Without one, Data Hub names it after the page in the URL."
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const updateNotebookLinkTool = {
  name: "update_notebook_link",
  group: "notebook_links",
  scope: "runs:link",
  title: "Update Notebook Link",
  description:
    "Change a lab notebook link's URL, label, or both. Get the link ID from get_run's notebookLinks. Pass label: null to clear the label; leave a field out to keep it.",
  outputSchema: updateNotebookLinkOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runId: z.string().describe("Run identifier within the instrument"),
    linkId: z.string().uuid().describe("The link's id"),
    url: notebookLinkUrlSchema.optional().describe("New http or https URL"),
    label: notebookLinkLabelInputSchema
      .nullable()
      .optional()
      .describe("New label. Null or blank clears it."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const removeNotebookLinkTool = {
  name: "remove_notebook_link",
  group: "notebook_links",
  scope: "runs:link",
  title: "Remove Notebook Link",
  description: `Remove the link to a lab notebook page from up to ${NOTEBOOK_LINK_BULK_RUNS_MAX} runs on one instrument. Matches any saved link to the same page, even when its URL differs in www., query string, or fragment. Links are deleted for good, so confirm with the user first.`,
  outputSchema: removeNotebookLinkOutputSchema,
  inputSchema: {
    instrumentId: z.string().describe("Instrument identifier"),
    runIds,
    url: notebookLinkUrlSchema.describe("The notebook page's URL"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const listNotebookLinkNamesTool = {
  name: "list_notebook_link_names",
  group: "notebook_links",
  scope: "runs:read",
  title: "List Notebook Link Names",
  description:
    "List the names of the lab notebook links on runs, with how many runs have a link by each name, most-used first. A link's name is its display_name: its label, or a name worked out from its URL when it has no label. Deleted runs don't count. Pass a name to search_runs as notebookLinkName to list those runs.",
  outputSchema: listNotebookLinkNamesOutputSchema,
  inputSchema: {
    instrumentId: z
      .string()
      .optional()
      .describe("Only count runs on this instrument. Leave out for all."),
  },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const NOTEBOOK_LINK_TOOL_DEFS = [
  listNotebookLinkNamesTool,
  addNotebookLinkTool,
  updateNotebookLinkTool,
  removeNotebookLinkTool,
] as const;
