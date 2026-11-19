import { z } from "zod";

export const searchQuery = z.object({
  q: z.string().optional(),
  scope: z
    .enum([
      "all",
      "runs",
      "notebooks",
      "files",
      "instruments",
      "users",
      "comments",
    ])
    .optional(),
});

const searchNotebookResult = z.object({
  type: z.literal("notebook"),
  id: z.string().uuid(),
  name: z.string(),
  url: z.string().describe("The notebook's page, ready to open."),
  runCount: z
    .number()
    .int()
    .describe(
      "How many runs are in the notebook, however many results the search shows. Deleted runs don't count."
    ),
});

export const searchResponse = z.object({
  runs: z.array(z.record(z.string(), z.unknown())),
  notebooks: z
    .array(searchNotebookResult)
    .describe(
      "Lab notebooks whose name or description matches. A pasted link returns only the notebook for that page. Deleted notebooks are left out."
    ),
  files: z.array(z.record(z.string(), z.unknown())),
  instruments: z.array(z.record(z.string(), z.unknown())),
  users: z.array(z.record(z.string(), z.unknown())),
  comments: z.array(z.record(z.string(), z.unknown())),
});
