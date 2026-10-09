import { listChangelogEntries } from "@/lib/changelog/entries";
import snapshot from "./docs-bundle.snapshot.json";
import { type MarkdownSection, splitSections, toPlainText } from "./markdown";

const CHANGELOG_PREFIX = "changelog/";
const MAX_SUGGESTIONS = 3;

export interface DocSection extends MarkdownSection {
  plainText: string;
}

interface DocEntryBase {
  /** Plain text before the first `##` heading, or "" when there is none. */
  introText: string;
  markdown: string;
  /** `manage-tokens` for a docs page, `changelog/<entry id>` for a change. */
  page: string;
  sections: DocSection[];
  title: string;
}

export interface DocsPageEntry extends DocEntryBase {
  description: string;
  kind: "docs";
}

export interface ChangelogDocEntry extends DocEntryBase {
  /** Day the change shipped, as YYYY-MM-DD. */
  date: string;
  /** The entry's own `docs` link, if it has one. */
  docsUrl: string | null;
  kind: "changelog";
}

export type DocEntry = DocsPageEntry | ChangelogDocEntry;

export interface DocPageSummary {
  description: string;
  page: string;
  title: string;
}

function splitPage(
  markdown: string
): Pick<DocEntryBase, "introText" | "sections"> {
  const { intro, sections } = splitSections(markdown);
  return {
    introText: toPlainText(intro),
    sections: sections.map((section) => ({
      ...section,
      plainText: toPlainText(section.text),
    })),
  };
}

function buildBundle(): DocEntry[] {
  const pages = snapshot.pages.map(
    (page): DocsPageEntry => ({
      kind: "docs",
      page: page.page,
      title: page.title,
      description: page.description,
      markdown: page.markdown,
      ...splitPage(page.markdown),
    })
  );

  const changes = listChangelogEntries().map((entry): ChangelogDocEntry => {
    const markdown = `# ${entry.title} (${entry.date})\n\n${entry.body}${
      entry.docs ? `\n\nRelated docs: ${entry.docs}` : ""
    }`;
    return {
      kind: "changelog",
      page: `${CHANGELOG_PREFIX}${entry.id}`,
      title: entry.title,
      date: entry.date,
      docsUrl: entry.docs ?? null,
      markdown,
      ...splitPage(markdown),
    };
  });

  return [...pages, ...changes];
}

// Docs are fixed per deployment, and so is the changelog; dev skips the cache
// so a new changelog file shows up without a restart.
let cached: DocEntry[] | null = null;

export function getDocsBundle(): DocEntry[] {
  if (process.env.NODE_ENV === "production" && cached) {
    return cached;
  }
  const bundle = buildBundle();
  if (process.env.NODE_ENV === "production") {
    cached = bundle;
  }
  return bundle;
}

export function listDocPages(): DocPageSummary[] {
  return getDocsBundle()
    .filter((entry): entry is DocsPageEntry => entry.kind === "docs")
    .map(({ page, title, description }) => ({ page, title, description }));
}

export function findDoc(page: string): DocEntry | undefined {
  return getDocsBundle().find((entry) => entry.page === page);
}

/** Error text that lets an agent correct a wrong page ID in one more call. */
export function unknownPageMessage(page: string): string {
  const pages = listDocPages().map((doc) => doc.page);
  const close = closestPages(page.toLowerCase(), pages);
  return [
    `Page '${page}' not found.`,
    close.length > 0 ? `Closest: ${close.join(", ")}.` : null,
    `Docs pages: ${pages.join(", ")}.`,
    "Changelog entries are named changelog/<entry id>; find them with search_docs.",
  ]
    .filter(Boolean)
    .join(" ");
}

// Catches a typo (`manage-tokns`), a missing word (`install-watcher`), and
// another form of a word (`troubleshooting`), closest first.
function closestPages(typed: string, pages: readonly string[]): string[] {
  if (typed.length < 2) {
    return [];
  }
  return pages
    .map((page) => ({ page, distance: pageDistance(typed, page) }))
    .filter(
      (candidate): candidate is { page: string; distance: number } =>
        candidate.distance !== null
    )
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ page }) => page);
}

function pageDistance(typed: string, page: string): number | null {
  if (page.includes(typed) || typed.includes(page)) {
    return 0;
  }
  const distance = editDistance(typed, page);
  const allowed = Math.max(2, Math.floor(page.length / 4));
  return distance <= allowed || sharesWordStem(typed, page) ? distance : null;
}

function sharesWordStem(a: string, b: string): boolean {
  const words = (text: string) =>
    text.split(/[-/]/).filter((word) => word.length >= 4);
  return words(a).some((left) =>
    words(b).some((right) => left.startsWith(right) || right.startsWith(left))
  );
}

/** Levenshtein distance: the fewest single-letter edits from `a` to `b`. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitution
      );
    }
    previous = current;
  }
  return previous[b.length];
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
