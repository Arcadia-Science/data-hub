import { z } from "zod";
import type {
  AddRunOutcome,
  NotebookSort,
  RemoveRunOutcome,
} from "@/lib/api/notebooks";
import {
  NOTEBOOK_RUNS_PER_REQUEST_MAX,
  NOTEBOOKS_PER_RUN_MAX,
  notebookDescriptionSchema,
  notebookLinkUrlSchema,
  notebookNameSchema,
} from "@/lib/notebook-links/url";
import { isoDateTime, paginationSchema } from "./common";
import { notebookUrlKey, notebookUser, tokenActor } from "./runs";

// The lists below repeat values from `@/lib/api/notebooks`, which loads the
// database, so the OpenAPI schemas can't import them. `satisfies` keeps each
// value valid there.
const NOTEBOOK_SORT_VALUES = [
  "last_run",
  "name",
  "run_count",
  "created",
] as const satisfies readonly NotebookSort[];
const ADD_RUN_OUTCOME_VALUES = [
  "added",
  "already_in_lab_notebook",
  "run_deleted",
  "limit_reached",
  "not_found",
] as const satisfies readonly AddRunOutcome[];
const REMOVE_RUN_OUTCOME_VALUES = [
  "removed",
  "not_in_lab_notebook",
  "run_deleted",
  "not_found",
] as const satisfies readonly RemoveRunOutcome[];
// The same as `NOTEBOOKS_PER_PAGE_MAX` in `@/lib/api/notebooks`.
const NOTEBOOK_LIST_PER_PAGE_MAX = 200;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const notebook = z
  .object({
    id: z.string().uuid(),
    url: z.string().openapi({
      description: "The lab notebook's page, ready to open.",
    }),
    url_key: notebookUrlKey,
    name: z.string(),
    description: z.string().nullable(),
    owner: notebookUser.nullable(),
    run_count: z.number().int().openapi({
      description:
        "How many runs are in the lab notebook. Deleted runs don't count.",
    }),
    instrument_count: z.number().int().openapi({
      description: "How many instruments those runs come from.",
    }),
    last_run_at: isoDateTime
      .nullable()
      .describe(
        "When the newest run started: its acquired time, or its created time when that is missing. Null when the lab notebook has no runs."
      ),
    created_at: isoDateTime,
    // At most one of each `*_by` and `*_by_token` pair is set: a person or a
    // token. Both are null once that person is deleted.
    created_by: notebookUser.nullable(),
    created_by_token: tokenActor.nullable(),
    updated_at: isoDateTime,
    updated_by: notebookUser.nullable(),
    updated_by_token: tokenActor.nullable(),
    deleted_at: isoDateTime.nullable(),
    deleted_by: notebookUser.nullable(),
    deleted_by_token: tokenActor.nullable(),
  })
  .openapi("LabNotebook");

export const notebookListResponse = z.object({
  data: z.array(notebook),
  pagination: paginationSchema,
});

const runRefResult = {
  instrument_id: z.string(),
  run_id: z.string().openapi({
    description: "The run ID as sent, without spaces at the start or end.",
  }),
};
const count = z.number().int();

export const notebookRunsAdded = z
  .object({
    lab_notebook_id: z.string().uuid(),
    results: z
      .array(
        z.object({
          ...runRefResult,
          outcome: z.enum(ADD_RUN_OUTCOME_VALUES),
        })
      )
      .openapi({
        description: `One outcome per run, in the order sent. \`already_in_lab_notebook\`: the run was in the lab notebook already. \`run_deleted\`: the run is deleted. \`limit_reached\`: the run is already in ${NOTEBOOKS_PER_RUN_MAX} lab notebooks, the most allowed, counting deleted ones. \`not_found\`: there is no such run.`,
      }),
    counts: z.object({
      added: count,
      already_in_lab_notebook: count,
      run_deleted: count,
      limit_reached: count,
      not_found: count,
    }),
  })
  .openapi("LabNotebookRunsAdded");

export const notebookRunsRemoved = z
  .object({
    lab_notebook_id: z.string().uuid(),
    results: z
      .array(
        z.object({
          ...runRefResult,
          outcome: z.enum(REMOVE_RUN_OUTCOME_VALUES),
        })
      )
      .openapi({
        description:
          "One outcome per run, in the order sent. `not_in_lab_notebook`: the run wasn't in the lab notebook. `run_deleted`: the run is deleted. `not_found`: there is no such run.",
      }),
    counts: z.object({
      removed: count,
      not_in_lab_notebook: count,
      run_deleted: count,
      not_found: count,
    }),
  })
  .openapi("LabNotebookRunsRemoved");

export const notebookCreated = z.object({
  lab_notebook: notebook,
  runs: notebookRunsAdded.nullable().openapi({
    description:
      "What happened to each run sent in `runs`. Null when none were.",
  }),
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const notebookListQuery = z.object({
  q: z.string().optional().openapi({
    description:
      "Text in a lab notebook's name, description, or link, ignoring case. A pasted link, with or without `https://`, matches only the lab notebook for that page.",
  }),
  owner_id: z.string().optional().openapi({
    description: "Lists only lab notebooks this user owns.",
  }),
  include_deleted: z.enum(["true", "false"]).optional().openapi({
    description: "`true` lists deleted lab notebooks too.",
  }),
  sort: z.enum(NOTEBOOK_SORT_VALUES).optional().openapi({
    description:
      "`last_run` (default): when the newest run started. `name`, `run_count`, or `created`.",
  }),
  order: z.enum(["asc", "desc"]).optional().openapi({
    description: "Defaults to `asc` for `name` and `desc` for the others.",
  }),
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce
    .number()
    .int()
    .min(1)
    .max(NOTEBOOK_LIST_PER_PAGE_MAX)
    .optional()
    .openapi({ description: "Defaults to 50." }),
});

const notebookRunRef = z.object({
  instrument_id: z.string().min(1),
  run_id: z.string().min(1),
});

const notebookRunRefs = z
  .array(notebookRunRef)
  .max(NOTEBOOK_RUNS_PER_REQUEST_MAX);

// The routes save a blank description as null.
const descriptionInput = notebookDescriptionSchema.nullable().optional();

export const createNotebookBody = z.object({
  url: notebookLinkUrlSchema,
  name: notebookNameSchema,
  description: descriptionInput.openapi({
    description: "Optional. Blank or null means none.",
  }),
  owner_id: z.string().min(1).nullable().optional().openapi({
    description:
      'The user who owns the lab notebook. Left out or null, it has no owner. `"me"` means the signed-in person, so a token can\'t use it.',
  }),
  runs: notebookRunRefs.optional().openapi({
    description: `Runs to add as the lab notebook is created, at most ${NOTEBOOK_RUNS_PER_REQUEST_MAX}. They can belong to different instruments.`,
  }),
});

export const updateNotebookBody = z
  .object({
    name: notebookNameSchema.optional(),
    description: descriptionInput.openapi({
      description: "Null or blank clears it. Leave it out to keep it.",
    }),
    owner_id: z.string().min(1).nullable().optional().openapi({
      description:
        'Null clears the owner. Leave it out to keep it. `"me"` means the signed-in person, so a token can\'t use it.',
    }),
    url: notebookLinkUrlSchema.optional().openapi({
      description:
        "A new link. It must point to a page no other lab notebook has, deleted ones included.",
    }),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.description !== undefined ||
      body.owner_id !== undefined ||
      body.url !== undefined,
    { message: "Send name, description, owner_id, or url" }
  );

export const notebookRunsBody = z.object({
  runs: notebookRunRefs.min(1).openapi({
    description: `The runs to add or remove, at most ${NOTEBOOK_RUNS_PER_REQUEST_MAX}. They can belong to different instruments.`,
  }),
});
