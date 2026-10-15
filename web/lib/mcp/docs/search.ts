import MiniSearch from "minisearch";
import { createSearchTerms, wordsNeeded } from "@/lib/mcp/search-terms";
import { type DocEntry, type DocSection, getDocsBundle } from "./bundle";
import { makeExcerpt } from "./markdown";

const SEARCH_RESULT_LIMIT = 5;
// Keeps the `SEARCH_RESULT_LIMIT` results from all being sections of one long
// page.
const MAX_HITS_PER_PAGE = 2;

const { normalize: normalizeTerm, queryWords } = createSearchTerms();

interface IndexedPassage {
  description: string;
  heading: string;
  id: string;
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
  const { description } = entry;
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
      pageTitle: entry.title,
      description,
      heading,
      text,
    },
  }));
}

interface DocsIndex {
  index: MiniSearch<IndexedPassage>;
  passages: Map<string, Passage>;
}

let cached: DocsIndex | null = null;

function getIndex(): DocsIndex {
  // The bundle is fixed per deployment, so the index is built once per server
  // instance.
  if (cached) {
    return cached;
  }

  const index = new MiniSearch<IndexedPassage>({
    fields: ["heading", "pageTitle", "description", "text"],
    processTerm: normalizeTerm,
    searchOptions: {
      boost: { heading: 3, pageTitle: 2, description: 1.5 },
      // Short terms such as "run" would otherwise prefix-match half the docs.
      prefix: (term) => term.length >= 4,
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
    },
  });

  const passages = new Map<string, Passage>();
  const documents: IndexedPassage[] = [];
  for (const entry of getDocsBundle()) {
    for (const { passage, indexed } of passagesOf(entry)) {
      passages.set(indexed.id, passage);
      documents.push(indexed);
    }
  }
  index.addAll(documents);

  cached = { index, passages };
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
