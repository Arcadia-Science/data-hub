import { z } from "zod";
import { isoDateTime } from "@/lib/api/openapi/schemas/common";
import { mcpActorTokenSchema } from "./common.output";

// Plain Zod only — do not import from openapi/schemas/runs (those use
// `.openapi()` and require registry side effects that unit tests skip).

const mcpNotebookLinkUserSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  initials: z.string(),
  avatarUrl: z.string().nullable(),
});

/** A lab notebook link, in the same shape the REST API returns. */
export const mcpNotebookLinkSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  // Two links with the same key point to the same page.
  url_key: z.string(),
  label: z.string().nullable(),
  // The label, or a name worked out from the URL.
  display_name: z.string(),
  created_at: isoDateTime,
  // At most one of `created_by` and `created_by_token` is set.
  created_by: mcpNotebookLinkUserSchema.nullable(),
  created_by_token: mcpActorTokenSchema.nullable(),
  updated_at: isoDateTime,
  updated_by: mcpNotebookLinkUserSchema.nullable(),
  updated_by_token: mcpActorTokenSchema.nullable(),
});

export const addNotebookLinkOutputSchema = z.object({
  instrumentId: z.string(),
  url: z.string(),
  urlKey: z.string(),
  results: z.array(
    z.object({
      runId: z.string(),
      outcome: z.enum([
        "added",
        "already_linked",
        "run_deleted",
        "limit_reached",
        "not_found",
      ]),
      link: mcpNotebookLinkSchema.nullable(),
    })
  ),
  counts: z.object({
    added: z.number().int(),
    already_linked: z.number().int(),
    run_deleted: z.number().int(),
    limit_reached: z.number().int(),
    not_found: z.number().int(),
  }),
});

export const updateNotebookLinkOutputSchema = mcpNotebookLinkSchema;

export const removeNotebookLinkOutputSchema = z.object({
  instrumentId: z.string(),
  urlKey: z.string(),
  results: z.array(
    z.object({
      runId: z.string(),
      outcome: z.enum(["removed", "not_linked", "run_deleted", "not_found"]),
      removed: z.number().int(),
    })
  ),
  counts: z.object({
    removed: z.number().int(),
    not_linked: z.number().int(),
    run_deleted: z.number().int(),
    not_found: z.number().int(),
  }),
});
