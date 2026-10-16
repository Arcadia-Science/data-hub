import MiniSearch from "minisearch";
import { listChangelogEntries } from "@/lib/changelog/entries";
import type { ChangelogEntry } from "@/lib/changelog/parse";
import { toPlainText } from "@/lib/mcp/docs/markdown";
import { createSearchTerms, wordsNeeded } from "@/lib/mcp/search-terms";

// Every entry describes a change, so these words say nothing about which one
// a person means. A question made only of them lists entries by date instead.
// `s` is what the apostrophe in "what's" leaves behind.
const FILLER_WORDS = [
  "change",
  "changed",
  "changelog",
  "changes",
  "latest",
  "new",
  "newest",
  "recent",
  "recently",
  "s",
];

const { normalize, queryWords } = createSearchTerms(FILLER_WORDS);

interface IndexedEntry {
  id: string;
  text: string;
  title: string;
}

interface ChangelogIndex {
  entries: ChangelogEntry[];
  index: MiniSearch<IndexedEntry>;
}

let cached: ChangelogIndex | null = null;

function getIndex(): ChangelogIndex {
  const entries = listChangelogEntries();
  // The list is the same array on every call in production, so the index is
  // built once per server instance. In dev it is rebuilt with each read.
  if (cached?.entries === entries) {
    return cached;
  }

  const index = new MiniSearch<IndexedEntry>({
    fields: ["title", "text"],
    processTerm: normalize,
    searchOptions: {
      boost: { title: 3 },
      // Short terms such as "run" would otherwise prefix-match half the entries.
      prefix: (term) => term.length >= 4,
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
    },
  });
  index.addAll(
    entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      text: toPlainText(entry.body),
    }))
  );

  cached = { entries, index };
  return cached;
}

export interface ChangelogSearchInput {
  /** Inclusive YYYY-MM-DD. */
  dateFrom?: string;
  /** Inclusive YYYY-MM-DD. */
  dateTo?: string;
  limit: number;
  query?: string;
}

export interface ChangelogSearchOutcome {
  entries: ChangelogEntry[];
  /**
   * Entries that answer the question by the `wordsNeeded` bar. Null when
   * there was no question to answer. Zero when a word appears nowhere in the
   * changelog, which usually means the change was never written up.
   */
  goodMatches: number | null;
  /** Words of the question that appear nowhere in the changelog, as typed. */
  missingWords: string[];
  /** Matching entries, which is more than `entries` holds past the limit. */
  total: number;
}

/** Day of the oldest and newest entry, or null when there are none. */
export function changelogSpan(): { newest: string; oldest: string } | null {
  const { entries } = getIndex();
  const newest = entries[0];
  const oldest = entries.at(-1);
  return newest && oldest ? { newest: newest.date, oldest: oldest.date } : null;
}

export function searchChangelog({
  query,
  dateFrom,
  dateTo,
  limit,
}: ChangelogSearchInput): ChangelogSearchOutcome {
  const { entries, index } = getIndex();
  const inRange = (entry: ChangelogEntry) =>
    (!dateFrom || entry.date >= dateFrom) && (!dateTo || entry.date <= dateTo);

  const words = query ? queryWords(query) : new Map<string, string>();
  if (!query || words.size === 0) {
    const listed = entries.filter(inRange);
    return {
      entries: listed.slice(0, limit),
      goodMatches: null,
      missingWords: [],
      total: listed.length,
    };
  }

  const results = index.search(query);
  const found = new Set(results.flatMap((result) => result.queryTerms));
  const missingWords = [...words]
    .filter(([term]) => !found.has(term))
    .map(([, typed]) => typed);

  // `entries` is newest first, so a position breaks a tie in score toward the
  // newer entry.
  const position = new Map(entries.map((entry, i) => [entry.id, i]));
  const ranked: Array<{
    at: number;
    entry: ChangelogEntry;
    score: number;
    terms: number;
  }> = [];
  for (const result of results) {
    const at = position.get(result.id);
    const entry = at === undefined ? undefined : entries[at];
    if (at !== undefined && entry && inRange(entry)) {
      ranked.push({
        at,
        entry,
        score: result.score,
        terms: result.queryTerms.length,
      });
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.at - b.at);

  const needed = wordsNeeded(words.size);
  const goodMatches =
    missingWords.length > 0
      ? 0
      : ranked.filter((match) => match.terms >= needed).length;

  return {
    entries: ranked.slice(0, limit).map((match) => match.entry),
    goodMatches,
    missingWords,
    total: ranked.length,
  };
}
