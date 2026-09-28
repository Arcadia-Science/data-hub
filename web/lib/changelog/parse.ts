import YAML from "yaml";
import { z } from "zod";

// The date lives in the filename, not the frontmatter, so renaming a file
// is the only way to change when an entry appears to have shipped.
const FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

const frontmatterSchema = z
  .object({
    title: z.string().trim().min(1, "title is required"),
    docs: z
      .string()
      .trim()
      .refine(isHttpUrl, "docs must be an http(s) URL")
      .optional(),
  })
  .strict();

export interface ChangelogEntry {
  body: string;
  date: string;
  docs?: string;
  id: string;
  title: string;
}

export function parseChangelogFile(
  filename: string,
  contents: string
): ChangelogEntry {
  const match = FILENAME_PATTERN.exec(filename);
  const date = match?.[1];
  if (!match) {
    throw new Error(
      `${filename}: name must be YYYY-MM-DD-short-slug.md, with a lowercase slug`
    );
  }
  if (!(date && isRealCalendarDate(date))) {
    throw new Error(`${filename}: ${date ?? filename} is not a real date`);
  }

  const split = splitFrontmatter(filename, contents);
  let doc: unknown;
  try {
    doc = YAML.parse(split.frontmatter);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid YAML";
    throw new Error(`${filename}: ${message}`);
  }

  const parsed = frontmatterSchema.safeParse(doc ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => issue.message)
      .join("; ");
    throw new Error(`${filename}: ${message}`);
  }

  const body = split.body.trim();
  if (body.length === 0) {
    throw new Error(`${filename}: body is required`);
  }

  return {
    id: filename.slice(0, -".md".length),
    date,
    title: parsed.data.title,
    ...(parsed.data.docs ? { docs: parsed.data.docs } : {}),
    body,
  };
}

function splitFrontmatter(
  filename: string,
  contents: string
): { frontmatter: string; body: string } {
  const normalized = contents.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match?.[1]) {
    throw new Error(`${filename}: missing YAML frontmatter`);
  }
  return { frontmatter: match[1], body: match[2] ?? "" };
}

function isRealCalendarDate(isoDate: string): boolean {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!(year && month && day)) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
