import { z } from "zod";
import type { AddRunOutcome, RemoveRunOutcome } from "@/lib/api/notebooks";
import {
  isoDateTime,
  paginationSchema,
} from "@/lib/api/openapi/schemas/common";
import { mcpActorTokenSchema } from "./common.output";

// Plain Zod only — do not import from openapi/schemas/runs (those use
// `.openapi()` and require registry side effects that unit tests skip).

const mcpNotebookUserSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  initials: z.string(),
  avatarUrl: z.string().nullable(),
});

/** A lab notebook, in the same shape the REST API returns. */
export const mcpNotebookSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  // Two links with the same key point to the same page.
  url_key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  owner: mcpNotebookUserSchema.nullable(),
  // Live (not deleted) runs in the notebook, and the instruments they're on.
  run_count: z.number().int(),
  instrument_count: z.number().int(),
  // When its newest live run started.
  last_run_at: isoDateTime.nullable(),
  created_at: isoDateTime,
  // At most one of each `*_by` and `*_by_token` pair is set.
  created_by: mcpNotebookUserSchema.nullable(),
  created_by_token: mcpActorTokenSchema.nullable(),
  updated_at: isoDateTime,
  updated_by: mcpNotebookUserSchema.nullable(),
  updated_by_token: mcpActorTokenSchema.nullable(),
  // Set while the notebook is deleted. restore_lab_notebook clears them.
  deleted_at: isoDateTime.nullable(),
  deleted_by: mcpNotebookUserSchema.nullable(),
  deleted_by_token: mcpActorTokenSchema.nullable(),
});

/** A notebook as a run lists it, in the same shape the REST API returns. */
export const mcpRunNotebookSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  url: z.string(),
  url_key: z.string(),
  // When the run was added to the notebook, and by whom.
  linked_at: isoDateTime,
  linked_by: mcpNotebookUserSchema.nullable(),
  linked_by_token: mcpActorTokenSchema.nullable(),
});

export const listNotebooksOutputSchema = z.object({
  data: z.array(mcpNotebookSchema),
  pagination: paginationSchema,
});

export const getNotebookOutputSchema = mcpNotebookSchema;
export const updateNotebookOutputSchema = mcpNotebookSchema;
export const deleteNotebookOutputSchema = mcpNotebookSchema;
export const restoreNotebookOutputSchema = mcpNotebookSchema;

const ADD_OUTCOMES = [
  "added",
  "already_in_lab_notebook",
  "run_deleted",
  "limit_reached",
  "not_found",
] as const satisfies readonly AddRunOutcome[];

const REMOVE_OUTCOMES = [
  "removed",
  "not_in_lab_notebook",
  "run_deleted",
  "not_found",
] as const satisfies readonly RemoveRunOutcome[];

export const addRunsToNotebookOutputSchema = z.object({
  labNotebookId: z.string(),
  instrumentId: z.string(),
  // One entry per run, in the order given.
  results: z.array(
    z.object({ runId: z.string(), outcome: z.enum(ADD_OUTCOMES) })
  ),
  counts: z.object({
    added: z.number().int(),
    already_in_lab_notebook: z.number().int(),
    run_deleted: z.number().int(),
    limit_reached: z.number().int(),
    not_found: z.number().int(),
  }),
});

export const removeRunsFromNotebookOutputSchema = z.object({
  labNotebookId: z.string(),
  instrumentId: z.string(),
  // One entry per run, in the order given.
  results: z.array(
    z.object({ runId: z.string(), outcome: z.enum(REMOVE_OUTCOMES) })
  ),
  counts: z.object({
    removed: z.number().int(),
    not_in_lab_notebook: z.number().int(),
    run_deleted: z.number().int(),
    not_found: z.number().int(),
  }),
});

export const createNotebookOutputSchema = z.object({
  labNotebook: mcpNotebookSchema,
  // The runs passed in, or null when none were.
  runs: addRunsToNotebookOutputSchema.nullable(),
});
