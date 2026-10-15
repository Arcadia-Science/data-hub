import { z } from "zod";

const changelogEntrySchema = z.object({
  id: z.string().describe("Entry ID: the file name without `.md`."),
  title: z.string(),
  date: z.string().describe("YYYY-MM-DD the change was released."),
  markdown: z
    .string()
    .describe("The whole entry as Markdown, without its title."),
  url: z
    .string()
    .describe(
      "Link that opens this entry in Data Hub's changelog. Cite it in your answer."
    ),
  docsUrl: z
    .string()
    .nullable()
    .describe(
      "The docs page that explains the change. Null when the entry has none."
    ),
});

export const searchChangelogOutputSchema = z.object({
  entries: z.array(changelogEntrySchema),
  total: z
    .number()
    .int()
    .describe(
      "How many entries matched. Larger than `entries` when `limit` cut the list; narrow the dates to see the rest."
    ),
  hint: z
    .string()
    .optional()
    .describe(
      "Present when nothing matched, or no entry clearly matches the query. Says what to do next."
    ),
});
