import MiniSearch from "minisearch";

// Questions arrive as sentences. Without this, "how do I" matches every page.
// `data` and `hub` are here because every page names the product.
const STOP_WORDS = [
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
];

const tokenize: (text: string) => string[] = MiniSearch.getDefault("tokenize");

export interface SearchTerms {
  /** Null drops the term from the index and from queries. */
  normalize: (term: string) => string | null;
  /** The question's words as the index stores them, mapped to how they were typed. */
  queryWords: (query: string) => Map<string, string>;
}

/**
 * Word handling shared by the docs and changelog indexes, applied to the
 * index and the query alike. `extraStopWords` are filler for one index only.
 */
export function createSearchTerms(
  extraStopWords: readonly string[] = []
): SearchTerms {
  const stopWords = new Set([...STOP_WORDS, ...extraStopWords]);

  // Strips plurals only, so "tokens" finds "token" without a stemming library.
  function normalize(term: string): string | null {
    const lower = term.toLowerCase();
    if (stopWords.has(lower)) {
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

  function queryWords(query: string): Map<string, string> {
    const words = new Map<string, string>();
    for (const token of tokenize(query)) {
      const term = normalize(token);
      if (term && !words.has(term)) {
        words.set(term, token);
      }
    }
    return words;
  }

  return { normalize, queryWords };
}

// Search matches any one word, so a result alone says little. A section that
// holds two thirds of the question's words, rounded up, counts as an answer.
// The golden questions in `tests/unit/mcp-docs-search.test.ts` check the bar.
export function wordsNeeded(wordCount: number): number {
  return Math.ceil((wordCount * 2) / 3);
}
