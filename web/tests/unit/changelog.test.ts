import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasUnseen, listUnseen } from "@/hooks/use-changelog-seen";
import { changelogIntro } from "@/lib/changelog/copy";
import {
  listChangelogEntries,
  readChangelogEntries,
} from "@/lib/changelog/entries";
import { groupChangelogByDate } from "@/lib/changelog/group";
import { type ChangelogEntry, parseChangelogFile } from "@/lib/changelog/parse";

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
  it("lists the ids that have not been saved", () => {
    expect(listUnseen(["2026-09-22-runs", "2026-09-25-comments"], [])).toEqual([
      "2026-09-22-runs",
      "2026-09-25-comments",
    ]);
    expect(
      listUnseen(
        ["2026-09-22-runs", "2026-09-25-comments"],
        ["2026-09-22-runs"]
      )
    ).toEqual(["2026-09-25-comments"]);
  });

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

function entry(date: string, slug: string): ChangelogEntry {
  return {
    id: `${date}-${slug}`,
    date,
    title: slug,
    body: "Body",
  };
}

describe("groupChangelogByDate", () => {
  const now = new Date("2026-09-29T17:00:00.000Z");
  const timeZone = "America/Los_Angeles";

  it("groups a day together and keeps newest first", () => {
    const sections = groupChangelogByDate(
      [
        entry("2026-09-22", "runs"),
        entry("2026-09-22", "files"),
        entry("2026-09-02", "plates"),
        entry("2025-09-16", "older"),
      ],
      timeZone,
      now
    );

    expect(sections.map((section) => section.date)).toEqual([
      "2026-09-22",
      "2026-09-02",
      "2025-09-16",
    ]);
    expect(sections[0]?.entries.map((item) => item.id)).toEqual([
      "2026-09-22-runs",
      "2026-09-22-files",
    ]);
    expect(sections[0]?.heading).toBe("Tuesday, September 22");
    expect(sections[0]?.jumpLabel).toBe("September 22");
    expect(sections[2]?.heading).toBe("Tuesday, September 16, 2025");
    expect(sections[2]?.jumpLabel).toBe("September 16, 2025");
  });
});

describe("changelogIntro", () => {
  it("mentions how many entries are new", () => {
    expect(changelogIntro(0)).toBe("What's changed in Data Hub, newest first.");
    expect(changelogIntro(1)).toBe(
      "What's changed in Data Hub, newest first. 1 entry is new to you."
    );
    expect(changelogIntro(2)).toBe(
      "What's changed in Data Hub, newest first. 2 entries are new to you."
    );
  });
});
