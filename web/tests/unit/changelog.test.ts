import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasUnseen } from "@/hooks/use-changelog-seen";
import {
  listChangelogEntries,
  readChangelogEntries,
} from "@/lib/changelog/entries";
import { parseChangelogFile } from "@/lib/changelog/parse";

const VALID = `---
title: Recent comments
docs: https://datahub.arcadiascience.com/docs/comments
---

Comments now show up on the home page.
`;

describe("parseChangelogFile", () => {
  it("reads the date from the filename and the title from the frontmatter", () => {
    expect(parseChangelogFile("2026-09-25-recent-comments.md", VALID)).toEqual({
      id: "2026-09-25-recent-comments",
      date: "2026-09-25",
      title: "Recent comments",
      docs: "https://datahub.arcadiascience.com/docs/comments",
      body: "Comments now show up on the home page.",
    });
  });

  it("allows an entry with no docs link", () => {
    const contents = `---
title: Plate maps
---

384-well plates use the full page width.
`;
    expect(
      parseChangelogFile("2026-08-13-plate-maps.md", contents).docs
    ).toBeUndefined();
  });

  it("rejects a filename that is not a dated slug", () => {
    expect(() => parseChangelogFile("notes.md", VALID)).toThrow(
      /YYYY-MM-DD-short-slug/
    );
  });

  it("rejects a calendar date that does not exist", () => {
    expect(() => parseChangelogFile("2026-02-31-leap.md", VALID)).toThrow(
      /not a real date/
    );
  });

  it("rejects a missing body, a bad docs URL, and extra frontmatter", () => {
    expect(() =>
      parseChangelogFile("2026-09-01-empty.md", "---\ntitle: Empty\n---\n\n")
    ).toThrow(/body is required/);

    expect(() =>
      parseChangelogFile(
        "2026-09-01-bad-docs.md",
        "---\ntitle: Docs\ndocs: javascript:alert(1)\n---\n\nHi\n"
      )
    ).toThrow(/docs must be an http/);

    expect(() =>
      parseChangelogFile(
        "2026-09-01-extra.md",
        "---\ntitle: Extra\narea: api\n---\n\nHi\n"
      )
    ).toThrow(/unrecognized/i);
  });
});

describe("hasUnseen", () => {
  it("is true when any current id has not been saved", () => {
    expect(hasUnseen(["2026-09-25-comments"], [])).toBe(true);
    expect(
      hasUnseen(["2026-09-22-runs", "2026-09-25-comments"], ["2026-09-22-runs"])
    ).toBe(true);
  });

  it("is false when there are no entries or every id was saved", () => {
    expect(hasUnseen([], [])).toBe(false);
    expect(hasUnseen(["2026-09-25-comments"], ["2026-09-25-comments"])).toBe(
      false
    );
  });
});

describe("readChangelogEntries", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("returns nothing when the directory does not exist", () => {
    expect(
      readChangelogEntries(path.join(tmpdir(), "missing-changelog"))
    ).toEqual([]);
  });

  it("sorts newest dates first and ignores files that are not markdown", () => {
    directory = mkdtempSync(path.join(tmpdir(), "changelog-"));
    writeFileSync(path.join(directory, ".gitkeep"), "");
    writeFileSync(
      path.join(directory, "2026-08-13-plates.md"),
      "---\ntitle: Plates\n---\n\nWider plates.\n"
    );
    writeFileSync(
      path.join(directory, "2026-09-25-comments.md"),
      "---\ntitle: Comments\n---\n\nA comments page.\n"
    );
    writeFileSync(
      path.join(directory, "2026-09-25-feedback.md"),
      "---\ntitle: Feedback\n---\n\nSend feedback.\n"
    );

    expect(readChangelogEntries(directory).map((entry) => entry.id)).toEqual([
      "2026-09-25-comments",
      "2026-09-25-feedback",
      "2026-08-13-plates",
    ]);
  });

  it("throws when a markdown file does not match the name", () => {
    directory = mkdtempSync(path.join(tmpdir(), "changelog-"));
    writeFileSync(path.join(directory, "README.md"), "# notes\n");
    expect(() => readChangelogEntries(directory ?? "")).toThrow(
      /YYYY-MM-DD-short-slug/
    );
  });
});

describe("listChangelogEntries", () => {
  it("parses every file in content/changelog", () => {
    const entries = listChangelogEntries();
    for (let index = 1; index < entries.length; index++) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (!(previous && current)) {
        continue;
      }
      expect(previous.date >= current.date).toBe(true);
    }
  });
});
