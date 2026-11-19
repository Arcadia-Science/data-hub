import { z } from "zod";
import type { NotebookSort } from "@/lib/api/notebooks";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import {
  NOTEBOOK_RUNS_PER_REQUEST_MAX,
  notebookDescriptionSchema,
  notebookLinkUrlSchema,
  notebookNameSchema,
} from "@/lib/notebook-links/url";
import {
  addRunsToNotebookOutputSchema,
  createNotebookOutputSchema,
  deleteNotebookOutputSchema,
  getNotebookOutputSchema,
  listNotebooksOutputSchema,
  removeRunsFromNotebookOutputSchema,
  restoreNotebookOutputSchema,
  updateNotebookOutputSchema,
} from "./notebooks.output";

// The defs load without a database, so they can't import NOTEBOOK_SORTS from
// the service. `satisfies` keeps this list to sorts the service knows.
const NOTEBOOK_SORT_VALUES = [
  "last_run",
  "name",
  "run_count",
  "created",
] as const satisfies readonly NotebookSort[];

export const NOTEBOOKS_PER_PAGE_MCP_DEFAULT = 20;
export const NOTEBOOKS_PER_PAGE_MCP_MAX = 100;

const labNotebookId = z
  .string()
  .describe(
    "The lab notebook's id, from list_lab_notebooks or a run's lab notebooks"
  );

const runIds = z
  .array(z.string())
  .min(1)
  .max(NOTEBOOK_RUNS_PER_REQUEST_MAX)
  .describe(
    `Run identifiers within the instrument (1–${NOTEBOOK_RUNS_PER_REQUEST_MAX})`
  );

export const listNotebooksTool = {
  name: "list_lab_notebooks",
  group: "lab_notebooks",
  scope: "runs:read",
  title: "List Lab Notebooks",
  description:
    "List lab notebooks. A lab notebook is one page (Notion, Google Docs, or any http or https page) with a name, and it can hold runs from any instrument. Search by name, description, or a pasted link; a link finds only the lab notebook for that page. Each lab notebook has its run count, instrument count, and last run. List a lab notebook's runs with search_runs labNotebookId.",
  outputSchema: listNotebooksOutputSchema,
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe("A name, part of a description, or a pasted lab notebook link"),
    ownerId: z
      .string()
      .optional()
      .describe(
        'Only lab notebooks owned by this user: a user id, or "me" for the signed-in user'
      ),
    includeDeleted: z
      .boolean()
      .optional()
      .describe("Include deleted lab notebooks (default: false)"),
    sort: z
      .enum(NOTEBOOK_SORT_VALUES)
      .optional()
      .describe(
        "Sort field (default: last_run, when the lab notebook's newest run started)"
      ),
    order: z
      .enum(["asc", "desc"])
      .optional()
      .describe("Sort order (default: asc for name, desc for the rest)"),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Page number (default: 1)"),
    perPage: z
      .number()
      .int()
      .min(1)
      .max(NOTEBOOKS_PER_PAGE_MCP_MAX)
      .optional()
      .describe(
        `Results per page (default: ${NOTEBOOKS_PER_PAGE_MCP_DEFAULT}, max: ${NOTEBOOKS_PER_PAGE_MCP_MAX})`
      ),
  },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getNotebookTool = {
  name: "get_lab_notebook",
  group: "lab_notebooks",
  scope: "runs:read",
  title: "Get Lab Notebook",
  description:
    "Get one lab notebook by id: its page link, name, description, owner, run count, instrument count, last run, and who created, changed, or deleted it. Deleted lab notebooks are returned too, with deleted_at set. List its runs with search_runs labNotebookId.",
  outputSchema: getNotebookOutputSchema,
  inputSchema: { labNotebookId },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const createNotebookTool = {
  name: "create_lab_notebook",
  group: "lab_notebooks",
  scope: "lab-notebooks:write",
  title: "Create Lab Notebook",
  description: `Create a lab notebook for one page, and optionally add up to ${NOTEBOOK_RUNS_PER_REQUEST_MAX} runs from one instrument to it. Each page can have only one lab notebook, deleted ones included. If the page already has one, this fails with that lab notebook's id: add runs to it with add_runs_to_lab_notebook instead, after restore_lab_notebook when it is deleted. Search first with list_lab_notebooks and the link when unsure. The owner stays empty unless you pass ownerId. Acts as the signed-in user. Adding runs doesn't record who ran them; call claim_runs for that.`,
  outputSchema: createNotebookOutputSchema,
  inputSchema: {
    url: notebookLinkUrlSchema.describe(
      "The lab notebook page's http or https URL"
    ),
    name: notebookNameSchema.describe(
      "The lab notebook's name, usually the page's title"
    ),
    description: notebookDescriptionSchema
      .optional()
      .describe("Optional description"),
    ownerId: z
      .string()
      .optional()
      .describe(
        'The person responsible for the lab notebook: a user id, or "me" for the signed-in user. Leave out for no owner. global_search with scope users finds a colleague\'s id.'
      ),
    instrumentId: z
      .string()
      .optional()
      .describe("Instrument of the runs to add. Required with runIds."),
    runIds: runIds.optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
} as const satisfies McpToolDef;

export const updateNotebookTool = {
  name: "update_lab_notebook",
  group: "lab_notebooks",
  scope: "lab-notebooks:write",
  title: "Update Lab Notebook",
  description:
    "Change a lab notebook's name, description, owner, or page link. Leave a field out to keep it; pass null for description or ownerId to clear it. A new link must point to a page no other lab notebook has. A deleted lab notebook can't change until it is restored.",
  outputSchema: updateNotebookOutputSchema,
  inputSchema: {
    labNotebookId,
    name: notebookNameSchema.optional().describe("New name"),
    description: notebookDescriptionSchema
      .nullable()
      .optional()
      .describe("New description. Null or blank clears it."),
    ownerId: z
      .string()
      .nullable()
      .optional()
      .describe(
        'New owner: a user id, or "me" for the signed-in user. Null clears it.'
      ),
    url: notebookLinkUrlSchema
      .optional()
      .describe("New http or https URL for the page"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const deleteNotebookTool = {
  name: "delete_lab_notebook",
  group: "lab_notebooks",
  scope: "lab-notebooks:write",
  title: "Delete Lab Notebook",
  description:
    "Delete a lab notebook. Its runs stop listing it, but it keeps them, so restore_lab_notebook brings it back with the same runs. Confirm with the user first, and say how many runs it holds (run_count from get_lab_notebook).",
  outputSchema: deleteNotebookOutputSchema,
  inputSchema: { labNotebookId },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
} as const satisfies McpToolDef;

export const restoreNotebookTool = {
  name: "restore_lab_notebook",
  group: "lab_notebooks",
  scope: "lab-notebooks:write",
  title: "Restore Lab Notebook",
  description:
    "Bring back a deleted lab notebook with the runs it had. Find deleted lab notebooks with list_lab_notebooks includeDeleted.",
  outputSchema: restoreNotebookOutputSchema,
  inputSchema: { labNotebookId },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
} as const satisfies McpToolDef;

export const addRunsToNotebookTool = {
  name: "add_runs_to_lab_notebook",
  group: "lab_notebooks",
  scope: "lab-notebooks:write",
  title: "Add Runs to Lab Notebook",
  description: `Add up to ${NOTEBOOK_RUNS_PER_REQUEST_MAX} runs from one instrument to a lab notebook, and report an outcome for each. Runs already in it stay as they are, and deleted or missing runs are skipped. To link runs to a page, find its lab notebook with list_lab_notebooks and the link, or make one with create_lab_notebook. Acts as the signed-in user. Adding runs doesn't record who ran them; call claim_runs for that.`,
  outputSchema: addRunsToNotebookOutputSchema,
  inputSchema: {
    labNotebookId,
    instrumentId: z.string().describe("Instrument identifier"),
    runIds,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const removeRunsFromNotebookTool = {
  name: "remove_runs_from_lab_notebook",
  group: "lab_notebooks",
  scope: "lab-notebooks:write",
  title: "Remove Runs from Lab Notebook",
  description: `Remove up to ${NOTEBOOK_RUNS_PER_REQUEST_MAX} runs from one instrument from a lab notebook, and report an outcome for each. The lab notebook stays, even when it has no runs left.`,
  outputSchema: removeRunsFromNotebookOutputSchema,
  inputSchema: {
    labNotebookId,
    instrumentId: z.string().describe("Instrument identifier"),
    runIds,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const NOTEBOOK_TOOL_DEFS = [
  listNotebooksTool,
  getNotebookTool,
  createNotebookTool,
  updateNotebookTool,
  deleteNotebookTool,
  restoreNotebookTool,
  addRunsToNotebookTool,
  removeRunsFromNotebookTool,
] as const;
