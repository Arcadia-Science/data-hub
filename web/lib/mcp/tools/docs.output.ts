import { z } from "zod";

const docPageSummarySchema = z.object({
  page: z.string(),
  title: z.string(),
  description: z.string(),
});

const docsSearchResultSchema = z.object({
  page: z
    .string()
    .describe("Page ID to pass to read_doc (`changelog/<id>` for a change)."),
  title: z.string(),
  section: z
    .string()
    .nullable()
    .describe("Heading ID of the matching section, or null for the intro."),
  heading: z.string().nullable(),
  excerpt: z.string(),
  url: z
    .string()
    .nullable()
    .describe("Link to cite. Null for a change that has no docs page."),
  date: z
    .string()
    .nullable()
    .describe("YYYY-MM-DD the change shipped. Null for a docs page."),
});

export const searchDocsOutputSchema = z.object({
  results: z.array(docsSearchResultSchema),
  pages: z
    .array(docPageSummarySchema)
    .optional()
    .describe("Every docs page. Present only when nothing matched."),
  hint: z
    .string()
    .optional()
    .describe(
      "Present when no section matches most of the question. Says what to do next."
    ),
});

export const readDocOutputSchema = z.object({
  page: z.string(),
  title: z.string(),
  section: z.string().nullable(),
  heading: z.string().nullable(),
  url: z.string().nullable(),
  markdown: z.string(),
  sections: z
    .array(
      z.object({
        id: z.string(),
        heading: z.string(),
        level: z
          .number()
          .int()
          .describe("2 for a section, 3 for a subsection."),
      })
    )
    .describe("Heading IDs on the page, for reading one section at a time."),
});
