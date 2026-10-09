import MiniSearch from "minisearch";
import { type DocEntry, type DocSection, getDocsBundle } from "./bundle";
import { makeExcerpt } from "./markdown";

const SEARCH_RESULT_LIMIT = 5;
// Keeps the `SEARCH_RESULT_LIMIT` results from all being sections of one long
// page.
const MAX_HITS_PER_PAGE = 2;
// Changelog entries are short, so they would otherwise outrank the docs page
// that explains the same thing in more depth.
const CHANGELOG_WEIGHT = 0.7;

// Questions arrive as sentences. Without this, "how do I" matches every page.
// `data` and `hub` are here because every page names the product.
const STOP_WORDS = new Set([
  "a",
  "about",
  "am",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "could",
  "data",
  "did",
  "do",
  "does",
  "for",
  "from",
  "get",
  "had",
  "has",
  "have",
  "how",
  "hub",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "much",
  "my",
  "myself",
  "of",
  "on",
  "or",
  "our",
  "should",
  "so",
  "that",
  "the",
  "their",
  "then",
  "there",
  "this",
  "to",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

// Strips plurals only, applied to the index and the query alike, so "tokens"
// finds "token" without a stemming library.
function normalizeTerm(term: string): string | null {
  const lower = term.toLowerCase();
  if (STOP_WORDS.has(lower)) {
    return null;
  }
  if (lower.length > 4 && lower.endsWith("ies")) {
    return `${lower.slice(0, -3)}y`;
  }
  if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) {
    return lower.slice(0, -1);
  }
  return lower;
}

const tokenize: (text: string) => string[] = MiniSearch.getDefault("tokenize");

/** The question's words as the index stores them, mapped to how they were typed. */
function queryWords(query: string): Map<string, string> {
  const words = new Map<string, string>();
  for (const token of tokenize(query)) {
    const term = normalizeTerm(token);
    if (term && !words.has(term)) {
      words.set(term, token);
    }
  }
  return words;
}

// Search matches any one word, so a result alone says little. A section that
// holds two thirds of the question's words, rounded up, counts as an answer.
// The golden questions in `tests/unit/mcp-docs-search.test.ts` check the bar.
function wordsNeeded(wordCount: number): number {
  return Math.ceil((wordCount * 2) / 3);
}

interface IndexedPassage {
  description: string;
  heading: string;
  id: string;
  kind: DocEntry["kind"];
  pageTitle: string;
  text: string;
}

interface Passage {
  entry: DocEntry;
  /** Text the excerpt is cut from. */
  excerptSource: string;
  /** Null for the text before a page's first heading. */
  section: DocSection | null;
}

function passagesOf(
  entry: DocEntry
): Array<{ passage: Passage; indexed: IndexedPassage }> {
  const description = entry.kind === "docs" ? entry.description : "";
  const parts: Array<{
    heading: string;
    section: DocSection | null;
    text: string;
  }> = [];
  if (entry.introText || entry.sections.length === 0) {
    parts.push({ section: null, heading: entry.title, text: entry.introText });
  }
  for (const section of entry.sections) {
    parts.push({ section, heading: section.heading, text: section.plainText });
  }

  return parts.map(({ section, heading, text }) => ({
    passage: { entry, section, excerptSource: text || description },
    indexed: {
      id: `${entry.page}#${section?.id ?? ""}`,
      kind: entry.kind,
      pageTitle: entry.title,
      description,
      heading,
      text,
    },
  }));
}

interface DocsIndex {
  bundle: DocEntry[];
  index: MiniSearch<IndexedPassage>;
  passages: Map<string, Passage>;
}

let cached: DocsIndex | null = null;

function getIndex(): DocsIndex {
  const bundle = getDocsBundle();
  // The bundle is the same array on every call in production, so the index is
  // built once per server instance. Elsewhere it is rebuilt with the bundle.
  if (cached?.bundle === bundle) {
    return cached;
  }

  const index = new MiniSearch<IndexedPassage>({
    fields: ["heading", "pageTitle", "description", "text"],
    storeFields: ["kind"],
    processTerm: normalizeTerm,
    searchOptions: {
      boost: { heading: 3, pageTitle: 2, description: 1.5 },
      // Short terms such as "run" would otherwise prefix-match half the docs.
      prefix: (term) => term.length >= 4,
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
      boostDocument: (_id, _term, stored) =>
        stored?.kind === "changelog" ? CHANGELOG_WEIGHT : 1,
    },
  });

  const passages = new Map<string, Passage>();
  const documents: IndexedPassage[] = [];
  for (const entry of bundle) {
    for (const { passage, indexed } of passagesOf(entry)) {
      passages.set(indexed.id, passage);
      documents.push(indexed);
    }
  }
  index.addAll(documents);

  cached = { bundle, index, passages };
  return cached;
}

export interface DocsHit {
  entry: DocEntry;
  excerpt: string;
  section: DocSection | null;
}

export interface DocsSearchOutcome {
  /**
   * Sections that answer the question by the `wordsNeeded` bar. Zero when a
   * word appears nowhere in the docs, which usually means they don't cover it.
   */
  goodMatches: number;
  hits: DocsHit[];
  /** Words of the question that appear nowhere in the docs, as typed. */
  missingWords: string[];
}

// Matched terms are normalized (and plural-stripped), so cut a letter off long
// ones to still find the original word in the text.
function excerptTerms(terms: readonly string[]): string[] {
  return terms.map((term) => (term.length > 4 ? term.slice(0, -1) : term));
}

export function searchDocs(query: string): DocsSearchOutcome {
  const { index, passages } = getIndex();
  const words = queryWords(query);
  const results = index.search(query);

  const found = new Set(results.flatMap((result) => result.queryTerms));
  const missingWords = [...words]
    .filter(([term]) => !found.has(term))
    .map(([, typed]) => typed);
  const needed = wordsNeeded(words.size);
  const goodMatches =
    missingWords.length > 0
      ? 0
      : results.filter((result) => result.queryTerms.length >= needed).length;

  const perPage = new Map<string, number>();
  const hits: DocsHit[] = [];
  for (const result of results) {
    const passage = passages.get(result.id);
    if (!passage) {
      continue;
    }
    const used = perPage.get(passage.entry.page) ?? 0;
    if (used >= MAX_HITS_PER_PAGE) {
      continue;
    }
    perPage.set(passage.entry.page, used + 1);

    hits.push({
      entry: passage.entry,
      section: passage.section,
      excerpt: makeExcerpt(passage.excerptSource, excerptTerms(result.terms)),
    });
    if (hits.length >= SEARCH_RESULT_LIMIT) {
      break;
    }
  }

  return { goodMatches, hits, missingWords };
}
