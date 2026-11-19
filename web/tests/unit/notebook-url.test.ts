import { describe, expect, it } from "vitest";
import {
  blankToNull,
  NOTEBOOK_LINK_URL_MAX_LENGTH,
  NOTEBOOK_NAME_MAX_LENGTH,
  notebookDescriptionSchema,
  notebookLinkUrlSchema,
  notebookNameFromUrl,
  notebookNameSchema,
  notebookSearchKey,
  notebookUrlKey,
  parseNotebookLinkUrl,
} from "@/lib/notebook-links/url";

const NOTION_ID = "3f2a9c01b7e44d1a8c2f4e5d6a7b8c9d";
const NOTION_UUID = "3f2a9c01-b7e4-4d1a-8c2f-4e5d6a7b8c9d";

describe("notebookUrlKey", () => {
  it.each([
    ["http://example.com/eln/entry-4", "scheme"],
    ["https://www.example.com/eln/entry-4", "www."],
    ["https://example.com/eln/entry-4/", "trailing slash"],
    ["https://example.com/eln/entry-4#results", "fragment"],
    ["https://example.com/eln/entry-4?utm_source=slack&fbclid=x", "tracking"],
    ["https://example.com:443/eln/entry-4", "default port"],
    ["https://EXAMPLE.com/eln/entry-4", "host case"],
  ])("treats %s as the same page (%s)", (variant) => {
    expect(notebookUrlKey(variant)).toBe(
      notebookUrlKey("https://example.com/eln/entry-4")
    );
  });

  it("keeps meaningful query parameters, in a stable order", () => {
    const a = notebookUrlKey(
      "https://wiki.example.com/pages/viewpage.action?pageId=12&spaceKey=LAB"
    );
    const b = notebookUrlKey(
      "https://wiki.example.com/pages/viewpage.action?spaceKey=LAB&pageId=12"
    );
    expect(a).toBe(b);
    expect(a).not.toBe(
      notebookUrlKey(
        "https://wiki.example.com/pages/viewpage.action?pageId=13&spaceKey=LAB"
      )
    );
  });

  it("keeps path case and non-default ports apart", () => {
    expect(notebookUrlKey("https://docs.example.com/d/AbC")).not.toBe(
      notebookUrlKey("https://docs.example.com/d/abc")
    );
    expect(notebookUrlKey("https://example.com:8443/a")).not.toBe(
      notebookUrlKey("https://example.com/a")
    );
  });

  it.each([
    `https://www.notion.so/arcadia/Heat-stress-day-1-${NOTION_ID}`,
    `https://www.notion.so/arcadia/Renamed-page-${NOTION_ID}?pvs=4`,
    `https://notion.so/${NOTION_ID}`,
    `https://arcadia.notion.site/Heat-stress-${NOTION_ID}`,
    `https://app.notion.com/p/${NOTION_ID}`,
    `https://www.notion.so/arcadia/${NOTION_UUID}`,
    `https://www.notion.so/arcadia/Experiments-0123456789abcdef0123456789abcdef?v=fedcba9876543210fedcba9876543210&p=${NOTION_ID}&pm=s`,
    `https://www.notion.so/arcadia/Heat-stress-day-1-${NOTION_ID.toUpperCase()}`,
  ])("matches Notion links by page ID: %s", (url) => {
    expect(notebookUrlKey(url)).toBe(`notion:${NOTION_ID}`);
  });

  it("falls back to the generic rule for a Notion URL with no page ID", () => {
    expect(notebookUrlKey("https://www.notion.so/arcadia/")).toBe(
      "notion.so/arcadia"
    );
  });

  it.each([
    ["javascript:alert(1)"],
    ["ftp://example.com/file"],
    ["/relative/path"],
    ["example.com/no-scheme"],
    ["https://user:secret@example.com/page"],
    ["   "],
    [`https://example.com/${"a".repeat(NOTEBOOK_LINK_URL_MAX_LENGTH)}`],
  ])("rejects %s", (input) => {
    expect(notebookUrlKey(input)).toBeNull();
  });
});

describe("parseNotebookLinkUrl", () => {
  it("keeps the full URL for opening and trims the input", () => {
    expect(
      parseNotebookLinkUrl("  https://example.com/a?view=1#part  ")
    ).toEqual({
      url: "https://example.com/a?view=1#part",
      urlKey: "example.com/a?view=1",
    });
  });
});

describe("notebookSearchKey", () => {
  it("normalizes a full URL", () => {
    expect(
      notebookSearchKey(`http://www.notion.so/Page-${NOTION_ID}/?pvs=4#x`)
    ).toBe(`notion:${NOTION_ID}`);
  });

  it("normalizes a URL pasted without its scheme", () => {
    expect(notebookSearchKey("www.example.com/eln/entry-4/")).toBe(
      "example.com/eln/entry-4"
    );
  });

  it("ignores plain text", () => {
    expect(notebookSearchKey("heat stress")).toBeNull();
    expect(notebookSearchKey("PR2-0042")).toBeNull();
  });
});

describe("notebookNameFromUrl", () => {
  it("names a page after its title, without the ID or the site", () => {
    expect(
      notebookNameFromUrl(
        `https://www.notion.so/arcadia/Osmotic-and-H2O2-stress-${NOTION_ID}`
      )
    ).toBe("Osmotic and H2O2 stress");
  });

  it("falls back to the site when the path is only an ID or empty", () => {
    expect(notebookNameFromUrl(`https://app.notion.com/p/${NOTION_ID}`)).toBe(
      "app.notion.com"
    );
    expect(notebookNameFromUrl("https://example.com/")).toBe("example.com");
  });

  it("strips UUIDs, decodes the segment, and skips edit or view", () => {
    expect(
      notebookNameFromUrl(
        `https://eln.example.com/entries/Gel%20ladder_run-${NOTION_UUID}/edit`
      )
    ).toBe("Gel ladder run");
  });

  it("keeps short hex-looking words", () => {
    expect(notebookNameFromUrl("https://example.com/notes/cafe-beef")).toBe(
      "cafe beef"
    );
  });

  it("keeps a segment that isn't valid percent-encoding as it is", () => {
    expect(notebookNameFromUrl("https://example.com/notes/100%25-done")).toBe(
      "100% done"
    );
  });
});

describe("lab notebook form schemas", () => {
  it("accepts and trims an http link", () => {
    expect(notebookLinkUrlSchema.parse(" https://example.com/a ")).toBe(
      "https://example.com/a"
    );
  });

  it("rejects a link without http or https", () => {
    expect(
      notebookLinkUrlSchema.safeParse("mailto:a@example.com").success
    ).toBe(false);
  });

  it("requires a one-line name and trims it", () => {
    expect(notebookNameSchema.parse(" Day 1 ")).toBe("Day 1");
    expect(notebookNameSchema.safeParse("   ").success).toBe(false);
    expect(notebookNameSchema.safeParse("Day\n1").success).toBe(false);
    expect(
      notebookNameSchema.safeParse("a".repeat(NOTEBOOK_NAME_MAX_LENGTH + 1))
        .success
    ).toBe(false);
  });

  it("treats a blank description as none", () => {
    expect(blankToNull(notebookDescriptionSchema.parse("   "))).toBeNull();
    expect(
      blankToNull(notebookDescriptionSchema.parse(" Two lines\nok "))
    ).toBe("Two lines\nok");
  });
});
