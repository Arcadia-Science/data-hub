import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type ChangelogEntry, parseChangelogFile } from "@/lib/changelog/parse";

const CHANGELOG_DIR = path.join(process.cwd(), "content/changelog");

// A deployment does not add or edit these files, and the layout reads them
// on every request. Dev skips the cache so a new file shows up without
// restarting the server.
let cached: ChangelogEntry[] | null = null;

export function listChangelogEntries(): ChangelogEntry[] {
  if (process.env.NODE_ENV === "production" && cached) {
    return cached;
  }
  const entries = readChangelogEntries(CHANGELOG_DIR);
  if (process.env.NODE_ENV === "production") {
    cached = entries;
  }
  return entries;
}

export function listChangelogIds(): string[] {
  return listChangelogEntries().map((entry) => entry.id);
}

export function readChangelogEntries(directory: string): ChangelogEntry[] {
  let names: string[];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissingDirectory(error)) {
      return [];
    }
    throw error;
  }

  const entries = names.map((name) =>
    parseChangelogFile(name, readFileSync(path.join(directory, name), "utf8"))
  );
  entries.sort((a, b) => {
    if (a.date !== b.date) {
      return a.date < b.date ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return entries;
}

function isMissingDirectory(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
