import MiniSearch from "minisearch";
import { type DocEntry, type DocSection, getDocsCorpus } from "./corpus";
import { makeExcerpt } from "./markdown";

export const SEARCH_RESULT_LIMIT = 5;
// Keeps five results from all being sections of one long page.
const MAX_HITS_PER_PAGE = 2;
// Changelog entries are short, so they would otherwise outrank the docs page
// that explains the same thing in more depth.
const CHANGELOG_WEIGHT = 0.7;

// Questions arrive as sentences. Without this, "how do I" matches every page.
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
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
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

interface IndexedPassage {
  description: string;
  docId: string;
  heading: string;
  id: string;
  kind: DocEntry["kind"];
  pageTitle: string;
  sectionId: string | null;
  text: string;
}

interface Passage {
  entry: DocEntry;
  section: DocSection | null;
}

function passagesOf(entry: DocEntry): Array<{
  passage: Passage;
  indexed: IndexedPassage;
}> {
  const base = {
    docId: entry.id,
    kind: entry.kind,
    pageTitle: entry.title,
    description: entry.description,
  };
  const parts: Array<{ section: DocSection | null; heading: string }> = [];
  if (entry.intro || entry.sections.length === 0) {
    parts.push({ section: entry.intro, heading: entry.title });
  }
  for (const section of entry.sections) {
    parts.push({ section, heading: section.heading });
  }

  return parts.map(({ section, heading }) => ({
    passage: { entry, section: section?.id ? section : null },
    indexed: {
      ...base,
      id: `${entry.id}#${section?.id ?? ""}`,
      sectionId: section?.id ? section.id : null,
      heading,
      text: section?.plainText ?? "",
    },
  }));
}

interface DocsIndex {
  corpus: DocEntry[];
  index: MiniSearch<IndexedPassage>;
  passages: Map<string, Passage>;
}

let cached: DocsIndex | null = null;

function getIndex(): DocsIndex {
  const corpus = getDocsCorpus();
  // The corpus is the same array on every call in production, so the index is
  // built once per server instance. Elsewhere it is rebuilt with the corpus.
  if (cached?.corpus === corpus) {
    return cached;
  }

  const index = new MiniSearch<IndexedPassage>({
    fields: ["heading", "pageTitle", "description", "text"],
    storeFields: ["docId", "kind", "sectionId"],
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
  for (const entry of corpus) {
    for (const { passage, indexed } of passagesOf(entry)) {
      passages.set(indexed.id, passage);
      documents.push(indexed);
    }
  }
  index.addAll(documents);

  cached = { corpus, index, passages };
  return cached;
}

export interface DocsHit {
  entry: DocEntry;
  excerpt: string;
  section: DocSection | null;
}

export interface DocsSearchOutcome {
  hits: DocsHit[];
  /** Matches before the per-page cap and the result limit. */
  totalMatches: number;
}

// Matched terms are normalized (and plural-stripped), so cut a letter off long
// ones to still find the original word in the text.
function excerptTerms(terms: readonly string[]): string[] {
  return terms.map((term) => (term.length > 4 ? term.slice(0, -1) : term));
}

export function searchDocs(
  query: string,
  limit = SEARCH_RESULT_LIMIT
): DocsSearchOutcome {
  const { index, passages } = getIndex();
  const results = index.search(query);

  const perPage = new Map<string, number>();
  const hits: DocsHit[] = [];
  for (const result of results) {
    const passage = passages.get(result.id);
    if (!passage) {
      continue;
    }
    const used = perPage.get(passage.entry.id) ?? 0;
    if (used >= MAX_HITS_PER_PAGE) {
      continue;
    }
    perPage.set(passage.entry.id, used + 1);

    const text = passage.section?.plainText ?? passage.entry.intro?.plainText;
    hits.push({
      ...passage,
      excerpt: makeExcerpt(
        text || passage.entry.description,
        excerptTerms(result.terms)
      ),
    });
    if (hits.length >= limit) {
      break;
    }
  }

  return { hits, totalMatches: results.length };
}
