import { describe, expect, it } from "vitest";
import {
  COMMENT_PREVIEW_MAX,
  commentBodyPreview,
  markdownToPlainText,
} from "@/lib/search-comment-preview";

describe("markdownToPlainText", () => {
  it("strips common markdown markers while keeping readable text", () => {
    expect(
      markdownToPlainText(
        "## Heading\n\n**Bold** and *italic* with a [link](https://example.com) and `code`."
      )
    ).toBe("Heading Bold and italic with a link and code.");
  });

  it("drops fenced code blocks", () => {
    expect(markdownToPlainText("Before\n```ts\nconst x = 1;\n```\nAfter")).toBe(
      "Before After"
    );
  });
});

describe("commentBodyPreview", () => {
  it("returns short plain text unchanged", () => {
    expect(commentBodyPreview("**Growth** looks good", "growth")).toBe(
      "Growth looks good"
    );
  });

  it("windows around a late match instead of always slicing from the start", () => {
    const prefix = "alpha ".repeat(40);
    const body = `${prefix}UBE2A rescue worked after titration`;
    const preview = commentBodyPreview(body, "UBE2A");
    expect(preview).toContain("UBE2A");
    expect(preview.startsWith("…")).toBe(true);
    // Ellipsis characters may add up to 2 chars beyond the soft max.
    expect(preview.length).toBeLessThanOrEqual(COMMENT_PREVIEW_MAX + 2);
    // A naive head slice would only contain the repeated prefix.
    expect(preview.startsWith("alpha")).toBe(false);
  });

  it("strips markdown so markers do not burn the preview budget", () => {
    const prefix = "**lead** ".repeat(40);
    const body = `${prefix}and then **critical-token** in context`;
    const preview = commentBodyPreview(body, "critical-token");
    expect(preview).toContain("critical-token");
    expect(preview).not.toContain("**");
  });
});
