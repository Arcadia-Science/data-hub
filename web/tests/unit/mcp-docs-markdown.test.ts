import { describe, expect, it } from "vitest";
import { findDoc, parseDocRef } from "@/lib/mcp/docs/corpus";
import {
  makeExcerpt,
  slugifyHeading,
  splitSections,
  toPlainText,
} from "@/lib/mcp/docs/markdown";

const PAGE = [
  "# Manage tokens (/docs/manage-tokens)",
  "",
  "Intro line.",
  "",
  "## Create a token [#create-a-token]",
  "",
  "Open Settings.",
  "",
  "### Scope presets",
  "",
  "Pick a preset.",
  "",
  "```bash",
  "# not a heading",
  "## also not a heading",
  "```",
  "",
  "## Revoke a token",
  "",
  "Click delete.",
].join("\n");

describe("splitSections", () => {
  const { intro, sections } = splitSections(PAGE);

  it("keeps the text before the first heading as the intro, without the title", () => {
    expect(intro).toBe("Intro line.");
  });

  it("finds ## and ### headings and ignores lines inside code fences", () => {
    expect(sections.map((s) => s.heading)).toEqual([
      "Create a token",
      "Scope presets",
      "Revoke a token",
    ]);
  });

  it("uses an explicit [#id] and falls back to the generated slug", () => {
    expect(sections.map((s) => s.id)).toEqual([
      "create-a-token",
      "scope-presets",
      "revoke-a-token",
    ]);
  });

  it("includes subsections in a section but not in its search text", () => {
    const create = sections[0];
    expect(create?.markdown).toContain("### Scope presets");
    expect(create?.markdown).toContain("## also not a heading");
    expect(create?.markdown).not.toContain("## Revoke a token");
    expect(create?.text).toBe("Open Settings.");
  });

  it("ends a subsection at the next heading of the same or higher level", () => {
    const presets = sections[1];
    expect(presets?.markdown).toContain("Pick a preset.");
    expect(presets?.markdown).not.toContain("Click delete.");
  });

  it("numbers repeated headings the way the docs site does", () => {
    const { sections: repeated } = splitSections(
      "## Install\n\none\n\n## Install\n\ntwo\n\n## Install\n\nthree"
    );
    expect(repeated.map((s) => s.id)).toEqual([
      "install",
      "install-1",
      "install-2",
    ]);
  });

  it("returns no sections for a page without headings", () => {
    const result = splitSections("# Title\n\nJust text.");
    expect(result.sections).toEqual([]);
    expect(result.intro).toBe("Just text.");
  });
});

describe("slugifyHeading", () => {
  it("lowercases, drops punctuation, and joins words with hyphens", () => {
    expect(slugifyHeading("Who can sign in?")).toBe("who-can-sign-in");
    expect(slugifyHeading("`data-hub-watcher service install`")).toBe(
      "data-hub-watcher-service-install"
    );
    expect(slugifyHeading("1. Create an access token")).toBe(
      "1-create-an-access-token"
    );
  });
});

describe("toPlainText", () => {
  it("keeps link text and drops the URL", () => {
    expect(toPlainText("See [Manage tokens](/docs/manage-tokens).")).toBe(
      "See Manage tokens."
    );
  });

  it("keeps the wording in component attributes and drops the tags", () => {
    expect(
      toPlainText(
        '<Cards>\n<Card title="Retire" href="/x" description="Stop uploads." />\n</Cards>'
      )
    ).toBe("Retire. Stop uploads.");
  });

  it("drops code fence lines but keeps the code", () => {
    expect(toPlainText("```bash\nuv tool install data-hub-watcher\n```")).toBe(
      "uv tool install data-hub-watcher"
    );
  });

  it("removes emphasis and inline code marks without leaving gaps", () => {
    expect(toPlainText("Use **bold** and `code`.")).toBe("Use bold and code.");
  });

  it("keeps angle brackets that are part of the text", () => {
    expect(toPlainText("DELETE /api/v1/tokens/<token_id> now")).toBe(
      "DELETE /api/v1/tokens/<token_id> now"
    );
  });

  it("drops blockquote markers and table divider rows", () => {
    const table = "| Status | Meaning |\n| --- | --- |\n| Online | Recent |";
    expect(toPlainText(table)).toBe("Status Meaning Online Recent");
    expect(toPlainText("> A quoted note")).toBe("A quoted note");
  });
});

describe("makeExcerpt", () => {
  const long = `${"filler words ".repeat(40)}the revoke button sits here ${"more filler ".repeat(40)}`;

  it("returns short text unchanged", () => {
    expect(makeExcerpt("Short answer.", ["answer"])).toBe("Short answer.");
  });

  it("centers on the first matching term and marks the cut ends", () => {
    const excerpt = makeExcerpt(long, ["revoke"]);
    expect(excerpt).toContain("revoke");
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(310);
  });

  it("starts at the beginning when no term appears", () => {
    const excerpt = makeExcerpt(long, ["nothing"]);
    expect(excerpt.startsWith("filler")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

describe("parseDocRef", () => {
  it("passes a plain page ID through", () => {
    expect(parseDocRef("manage-tokens")).toEqual({ page: "manage-tokens" });
  });

  it("accepts a docs path, a full URL, and a .md suffix", () => {
    expect(parseDocRef("/docs/manage-tokens").page).toBe("manage-tokens");
    expect(
      parseDocRef("https://datahub.example.com/docs/manage-tokens").page
    ).toBe("manage-tokens");
    expect(parseDocRef("docs/manage-tokens.md").page).toBe("manage-tokens");
  });

  it("reads a section from a URL fragment, and lets the argument win", () => {
    expect(
      parseDocRef("https://datahub.example.com/docs/manage-tokens#revoke")
    ).toEqual({ page: "manage-tokens", section: "revoke" });
    expect(parseDocRef("manage-tokens#revoke", "create-a-token")).toEqual({
      page: "manage-tokens",
      section: "create-a-token",
    });
  });

  it("leaves a changelog ID alone", () => {
    expect(
      parseDocRef("changelog/2026-10-08-hina-large-image-previews")
    ).toEqual({ page: "changelog/2026-10-08-hina-large-image-previews" });
  });
});

describe("findDoc", () => {
  it("returns a docs page and a changelog entry by ID", () => {
    expect(findDoc("manage-tokens")?.kind).toBe("docs");
    expect(
      findDoc("changelog/2026-10-08-hina-large-image-previews")?.kind
    ).toBe("changelog");
  });

  it("returns nothing for an unknown ID", () => {
    expect(findDoc("no-such-page")).toBeUndefined();
  });

  it("gives a changelog entry the date in its heading and its docs link", () => {
    const entry = findDoc("changelog/2026-10-08-hina-large-image-previews");
    expect(entry?.markdown).toContain("(2026-10-08)");
    expect(entry?.markdown).toContain("Related docs: ");
    expect(entry?.externalUrl).toContain("/docs/instrument-preprocessing");
  });
});
