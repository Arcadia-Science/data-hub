import { describe, expect, it } from "vitest";
import {
  type ChangelogDocEntry,
  getDocsBundle,
  listDocPages,
} from "@/lib/mcp/docs/bundle";
import { searchDocs } from "@/lib/mcp/docs/search";

// Real questions a person might put to an assistant, each with the page or
// pages that answer it. The right page has to be among the top three, so a
// docs rewrite or a search change that buries it fails here. Add questions as
// people report searches that missed.
const GOLDEN_QUESTIONS: Array<{ question: string; pages: string[] }> = [
  {
    question: "how do I create an access token for the watcher",
    pages: ["manage-tokens"],
  },
  { question: "how do I revoke a token", pages: ["manage-tokens"] },
  { question: "my watcher shows offline", pages: ["troubleshoot-a-watcher"] },
  {
    question: "files are not being detected by the watcher",
    pages: ["troubleshoot-a-watcher"],
  },
  {
    question: "how do I run the watcher as a Windows service",
    pages: ["windows-service"],
  },
  {
    question: "what does the stalled run status mean",
    pages: ["browse-runs", "concepts"],
  },
  { question: "how do I make someone an admin", pages: ["manage-members"] },
  { question: "who is allowed to sign in", pages: ["security"] },
  { question: "connect Claude Code to Data Hub", pages: ["mcp"] },
  {
    question: "how do I set up a new instrument",
    pages: ["set-up-an-instrument"],
  },
  { question: "retire an instrument", pages: ["retire-an-instrument"] },
  {
    question: "which instruments does Data Hub process files for",
    pages: ["instrument-preprocessing"],
  },
  {
    question: "how do I get Slack direct messages for new runs",
    pages: ["configure-notifications", "integrations"],
  },
  { question: "set up Linear for feedback reports", pages: ["integrations"] },
  {
    question: "how does the watcher decide which files make up a run",
    pages: ["configure-run-detection", "concepts"],
  },
  {
    question: "force a mandatory watcher update",
    pages: ["watcher-releases"],
  },
  {
    question: "what command updates the watcher",
    pages: ["install-the-watcher", "cli-reference"],
  },
  {
    question: "what is a heartbeat",
    pages: ["concepts", "manage-watchers"],
  },
  { question: "how do I deploy Data Hub myself", pages: ["self-hosting"] },
  {
    question: "how do I call the REST API",
    pages: ["api"],
  },
  {
    question: "large Hina Microscope image preview",
    pages: ["changelog/2026-10-08-hina-large-image-previews"],
  },
];

// Questions the docs don't answer. Search still finds sections that share a
// word, so each must come back with no section counted as an answer, which is
// what makes the agent offer feedback. Remove a question once the docs cover it.
const UNCOVERED_QUESTIONS = [
  "how do I export runs to Benchling",
  "does Data Hub support SAML single sign-on",
  "is there a mobile app",
  "can I schedule a weekly email digest",
  "how do I translate the interface into French",
  "does it integrate with Google Drive",
];

describe("docs search", () => {
  it.each(GOLDEN_QUESTIONS)("finds $pages for “$question”", ({
    question,
    pages,
  }) => {
    const { hits, goodMatches } = searchDocs(question);
    const top = hits.slice(0, 3).map((hit) => hit.entry.page);
    expect(
      pages.some((page) => top.includes(page)),
      `expected one of ${pages.join(", ")} in the top three, got ${top.join(", ")}`
    ).toBe(true);
    expect(goodMatches).toBeGreaterThan(0);
  });

  it.each(UNCOVERED_QUESTIONS)("counts no answer for “%s”", (question) => {
    expect(searchDocs(question).goodMatches).toBe(0);
  });

  it("names the words of the question the docs never use, as typed", () => {
    expect(
      searchDocs("how do I export runs to Benchling").missingWords
    ).toEqual(["Benchling"]);
    expect(searchDocs("how do I revoke a token").missingWords).toEqual([]);
  });

  it("returns nothing for a question made only of filler words", () => {
    expect(searchDocs("how do I").hits).toEqual([]);
  });

  it("returns nothing for words the docs never use", () => {
    expect(searchDocs("zxqv plorgnak").hits).toEqual([]);
  });

  it("returns at most five results and two from one page", () => {
    const { hits } = searchDocs("token");
    expect(hits.length).toBeLessThanOrEqual(5);
    const perPage = new Map<string, number>();
    for (const hit of hits) {
      perPage.set(hit.entry.page, (perPage.get(hit.entry.page) ?? 0) + 1);
    }
    expect(Math.max(...perPage.values())).toBeLessThanOrEqual(2);
  });

  it("puts the section that matched in the excerpt", () => {
    const { hits } = searchDocs("revoke a token");
    const revoke = hits.find((hit) => hit.section?.id === "revoke-a-token");
    expect(revoke?.excerpt.length).toBeGreaterThan(0);
    expect(revoke?.excerpt.length).toBeLessThanOrEqual(320);
  });

  it("finds a changelog entry by its wording", () => {
    const { hits } = searchDocs("Hina large image preview smaller");
    expect(hits.some((hit) => hit.entry.kind === "changelog")).toBe(true);
  });
});

describe("docs bundle", () => {
  it("lists the hand-written pages and leaves out the generated catalogs", () => {
    const ids = listDocPages().map((doc) => doc.page);
    expect(ids).toContain("manage-tokens");
    expect(ids).toContain("cli-reference");
    expect(ids).toContain("mcp");
    expect(ids).toContain("api");
    expect(ids).not.toContain("mcp/tools");
    expect(ids).not.toContain("mcp/prompts");
    expect(ids).not.toContain("mcp/resources");
    expect(ids.every((id) => !id.startsWith("changelog/"))).toBe(true);
  });

  it("gives every page a title and a description", () => {
    for (const doc of listDocPages()) {
      expect(doc.title, doc.page).not.toBe("");
      expect(doc.description, doc.page).not.toBe("");
    }
  });

  it("includes changelog entries as separate documents", () => {
    const changes = getDocsBundle().filter(
      (entry): entry is ChangelogDocEntry => entry.kind === "changelog"
    );
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.page.startsWith("changelog/")).toBe(true);
      expect(change.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  // Claude Code caps one tool result at 25,000 tokens. Three characters per
  // token is a deliberately pessimistic estimate for Markdown with code in it.
  it("keeps every page small enough to return in one tool result", () => {
    const limitChars = 25_000 * 3;
    for (const entry of getDocsBundle()) {
      const result = JSON.stringify({ markdown: entry.markdown });
      expect(result.length, entry.page).toBeLessThan(limitChars);
    }
  });

  it("gives every section on a page a different ID", () => {
    for (const entry of getDocsBundle()) {
      const ids = entry.sections.map((section) => section.id);
      expect(new Set(ids).size, entry.page).toBe(ids.length);
    }
  });
});
