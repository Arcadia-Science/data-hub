import { describe, expect, it } from "vitest";
import { listChangelogEntries } from "@/lib/changelog/entries";
import { searchChangelog } from "@/lib/mcp/changelog/search";
import { MAX_LIMIT } from "@/lib/mcp/tools/changelog.defs";

// Questions a person might put to an assistant about a change, each with the
// entries that answer it. One of them has to be among the top three, so a
// change to the index or to the wording of entries that buries it fails here.
const GOLDEN_QUESTIONS: Array<{ question: string; entries: string[] }> = [
  {
    question: "large Hina Microscope image preview",
    entries: ["2026-10-08-hina-large-image-previews"],
  },
  {
    question: "when did feedback start going to Linear",
    entries: [
      "2026-10-07-feedback-stored-in-linear",
      "2026-10-07-feedback-in-linear",
      "2026-10-07-connect-linear",
    ],
  },
  {
    question: "can I preview text files without downloading them",
    entries: ["2026-10-14-preview-text-files"],
  },
  {
    question: "Slack app credentials in settings",
    entries: ["2026-10-07-slack-app-credentials-in-settings"],
  },
  {
    question: "update_feedback tool",
    entries: ["2026-10-07-feedback-status-editing-removed"],
  },
];

// Questions the changelog doesn't answer. Each must come back with no entry
// counted as an answer, which is what makes the tool say so.
const UNCOVERED_QUESTIONS = [
  "how do I export runs to Benchling",
  "does Data Hub support SAML single sign-on",
  "is there a mobile app",
];

const LIMIT = 50;

describe("changelog search", () => {
  it.each(GOLDEN_QUESTIONS)("finds $entries for “$question”", ({
    question,
    entries,
  }) => {
    const outcome = searchChangelog({ query: question, limit: LIMIT });
    const top = outcome.entries.slice(0, 3).map((entry) => entry.id);
    expect(
      entries.some((id) => top.includes(id)),
      `expected one of ${entries.join(", ")} in the top three, got ${top.join(", ")}`
    ).toBe(true);
    expect(outcome.goodMatches).toBeGreaterThan(0);
  });

  it.each(UNCOVERED_QUESTIONS)("counts no answer for “%s”", (question) => {
    expect(searchChangelog({ query: question, limit: LIMIT }).goodMatches).toBe(
      0
    );
  });

  it("names the words of the question the changelog never uses, as typed", () => {
    expect(
      searchChangelog({ query: "export runs to Benchling", limit: LIMIT })
        .missingWords
    ).toEqual(["Benchling"]);
  });

  it("lists every entry newest first when there is no query", () => {
    const all = listChangelogEntries();
    const outcome = searchChangelog({ limit: MAX_LIMIT });
    expect(outcome.total).toBe(all.length);
    expect(outcome.goodMatches).toBeNull();
    expect(outcome.entries.map((entry) => entry.id)).toEqual(
      all.slice(0, MAX_LIMIT).map((entry) => entry.id)
    );
  });

  it.each([
    "what changed recently",
    "what's new",
    "latest changes",
  ])("lists by date when the question is only filler: “%s”", (query) => {
    const listed = searchChangelog({ limit: 5 });
    const outcome = searchChangelog({ query, limit: 5 });
    expect(outcome.entries.map((entry) => entry.id)).toEqual(
      listed.entries.map((entry) => entry.id)
    );
    expect(outcome.goodMatches).toBeNull();
  });

  it("still searches for a real word inside a filler question", () => {
    const outcome = searchChangelog({
      query: "what changed recently in Benchling",
      limit: LIMIT,
    });
    expect(outcome.missingWords).toEqual(["Benchling"]);
    expect(outcome.goodMatches).toBe(0);
  });

  it("includes both end days", () => {
    const [first, , third] = listChangelogEntries();
    expect(first && third).toBeTruthy();
    const outcome = searchChangelog({
      dateFrom: third?.date,
      dateTo: first?.date,
      limit: MAX_LIMIT,
    });
    const dates = outcome.entries.map((entry) => entry.date);
    expect(dates).toContain(third?.date);
    expect(dates).toContain(first?.date);
    expect(dates.every((date) => date >= (third?.date ?? ""))).toBe(true);
  });

  it("matches one day exactly", () => {
    const day = listChangelogEntries()[0]?.date ?? "";
    const outcome = searchChangelog({
      dateFrom: day,
      dateTo: day,
      limit: MAX_LIMIT,
    });
    expect(outcome.total).toBeGreaterThan(0);
    expect(outcome.entries.every((entry) => entry.date === day)).toBe(true);
  });

  it("reads missing words from the whole changelog, not only the dates asked for", () => {
    const newest = listChangelogEntries()[0]?.date ?? "";
    const outcome = searchChangelog({
      query: "feedback Linear",
      dateFrom: newest,
      limit: MAX_LIMIT,
    });
    expect(outcome.missingWords).toEqual([]);
    expect(outcome.entries.every((entry) => entry.date >= newest)).toBe(true);
  });

  it("caps the list at the limit and reports the full count", () => {
    const outcome = searchChangelog({ limit: 2 });
    expect(outcome.entries).toHaveLength(2);
    expect(outcome.total).toBeGreaterThan(2);
  });

  it("returns nothing for a range with no entries", () => {
    const outcome = searchChangelog({ dateFrom: "2099-01-01", limit: LIMIT });
    expect(outcome.entries).toEqual([]);
    expect(outcome.total).toBe(0);
  });

  it("returns nothing for words the changelog never uses", () => {
    expect(
      searchChangelog({ query: "zxqv plorgnak", limit: LIMIT }).total
    ).toBe(0);
  });

  // Claude Code caps one tool result at 25,000 tokens. Three characters per
  // token is a deliberately pessimistic estimate for Markdown, and 400
  // characters per entry covers its title, links, and JSON. When this fails,
  // lower MAX_LIMIT.
  it("keeps the largest allowed result small enough to return at once", () => {
    const largest = listChangelogEntries()
      .map((entry) => entry.body.length + entry.title.length + 400)
      .sort((a, b) => b - a)
      .slice(0, MAX_LIMIT)
      .reduce((sum, size) => sum + size, 0);
    expect(largest).toBeLessThan(25_000 * 3);
  });
});
