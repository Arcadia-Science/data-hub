import { listChangelogEntries } from "@/lib/changelog/entries";
import snapshot from "./docs-corpus.snapshot.json";
import { type MarkdownSection, splitSections, toPlainText } from "./markdown";

export const CHANGELOG_PREFIX = "changelog/";

export interface DocSection extends MarkdownSection {
  plainText: string;
}

export interface DocEntry {
  /** Date the entry shipped, for changelog entries only. */
  date: string | null;
  description: string;
  /** Link the entry itself carries (changelog entries may point at a docs page). */
  externalUrl: string | null;
  /** `manage-tokens` for a docs page, `changelog/<entry id>` for a change. */
  id: string;
  intro: DocSection | null;
  kind: "docs" | "changelog";
  markdown: string;
  sections: DocSection[];
  title: string;
}

export interface DocPageSummary {
  description: string;
  page: string;
  title: string;
}

function withPlainText(section: MarkdownSection): DocSection {
  return { ...section, plainText: toPlainText(section.text) };
}

function buildEntry(
  fields: Pick<
    DocEntry,
    "date" | "description" | "externalUrl" | "id" | "kind" | "title"
  > & { markdown: string }
): DocEntry {
  const { intro, sections } = splitSections(fields.markdown);
  return {
    ...fields,
    intro: intro
      ? withPlainText({
          id: "",
          heading: fields.title,
          level: 2,
          text: intro,
          markdown: intro,
        })
      : null,
    sections: sections.map(withPlainText),
  };
}

function buildCorpus(): DocEntry[] {
  const pages = snapshot.pages.map((page) =>
    buildEntry({
      id: page.page,
      kind: "docs",
      title: page.title,
      description: page.description,
      date: null,
      externalUrl: null,
      markdown: page.markdown,
    })
  );

  const changes = listChangelogEntries().map((entry) =>
    buildEntry({
      id: `${CHANGELOG_PREFIX}${entry.id}`,
      kind: "changelog",
      title: entry.title,
      description: "",
      date: entry.date,
      externalUrl: entry.docs ?? null,
      markdown: `# ${entry.title} (${entry.date})\n\n${entry.body}${
        entry.docs ? `\n\nRelated docs: ${entry.docs}` : ""
      }`,
    })
  );

  return [...pages, ...changes];
}

// Docs are fixed per deployment, and so is the changelog; dev skips the cache
// so a new changelog file shows up without a restart.
let cached: DocEntry[] | null = null;

export function getDocsCorpus(): DocEntry[] {
  if (process.env.NODE_ENV === "production" && cached) {
    return cached;
  }
  const corpus = buildCorpus();
  if (process.env.NODE_ENV === "production") {
    cached = corpus;
  }
  return corpus;
}

export function listDocPages(): DocPageSummary[] {
  return getDocsCorpus()
    .filter((entry) => entry.kind === "docs")
    .map((entry) => ({
      page: entry.id,
      title: entry.title,
      description: entry.description,
    }));
}

export function findDoc(id: string): DocEntry | undefined {
  return getDocsCorpus().find((entry) => entry.id === id);
}

/** Error text that lets an agent correct a wrong page ID in one more call. */
export function unknownPageMessage(page: string): string {
  const ids = listDocPages().map((doc) => doc.page);
  const needle = page.toLowerCase();
  const close = ids.filter(
    (id) => needle.length > 1 && (id.includes(needle) || needle.includes(id))
  );
  return [
    `Page '${page}' not found.`,
    close.length > 0 ? `Closest: ${close.join(", ")}.` : null,
    `Docs pages: ${ids.join(", ")}.`,
    "Changelog entries are named changelog/<entry id>; find them with search_docs.",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface DocRef {
  page: string;
  section?: string;
}

const DOCS_PATH = /^\/?docs\/(.+)$/;

/**
 * Accepts what an agent is likely to pass: a page id, a path such as
 * `/docs/manage-tokens`, a full docs URL, or any of those with a `#section`
 * or `.md` suffix. An explicit `section` argument wins over a URL fragment.
 */
export function parseDocRef(page: string, section?: string): DocRef {
  let path = page.trim();
  let fragment: string | undefined;

  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      path = url.pathname;
      fragment = url.hash.slice(1) || undefined;
    } catch {
      // Leave the text as is; the lookup reports it as an unknown page.
    }
  }

  const hashAt = path.indexOf("#");
  if (hashAt !== -1) {
    fragment ||= path.slice(hashAt + 1) || undefined;
    path = path.slice(0, hashAt);
  }

  path = path.replace(DOCS_PATH, "$1").replace(/^\/+|\/+$/g, "");
  path = path.replace(/\.md$/i, "");

  const wanted = section?.trim() || fragment;
  return wanted ? { page: path, section: wanted } : { page: path };
}
