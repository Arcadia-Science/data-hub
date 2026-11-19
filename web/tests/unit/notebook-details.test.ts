import { describe, expect, it } from "vitest";
import { NOTEBOOK_NAME_MAX_LENGTH } from "@/lib/notebook-links/url";
import {
  countLabel,
  deleteNotebookMessage,
  initialOwnerChoice,
  notebookEditPatch,
  notebookFieldErrors,
  notebookPageHref,
  notebooksEmptyMessage,
  suggestedNotebookName,
} from "@/lib/notebooks/details";

const NOTION_URL =
  "https://www.notion.so/lab/Heat-stress-day-1-3f2a9c01b7e44d1a8c2f4e5d6a7b8c01";

describe("notebookPageHref", () => {
  it("points at the lab notebook's page", () => {
    expect(notebookPageHref("3f2a9c1e-7b4d-4e0a-9c55-1d2e8f6a7b90")).toBe(
      "/lab-notebooks/3f2a9c1e-7b4d-4e0a-9c55-1d2e8f6a7b90"
    );
  });
});

describe("countLabel", () => {
  it("uses the singular for one and the plural otherwise", () => {
    expect(countLabel(0, "run")).toBe("0 runs");
    expect(countLabel(1, "run")).toBe("1 run");
    expect(countLabel(1200, "instrument")).toBe("1,200 instruments");
  });
});

describe("deleteNotebookMessage", () => {
  it("says how many runs leave the lab notebook and that restoring puts them back", () => {
    expect(deleteNotebookMessage("Growth curves", 12)).toBe(
      "This takes 12 runs out of “Growth curves”. Restoring the lab notebook puts them back."
    );
    expect(deleteNotebookMessage("Growth curves", 1)).toBe(
      "This takes 1 run out of “Growth curves”. Restoring the lab notebook puts it back."
    );
  });

  it("says so when the lab notebook has no runs", () => {
    expect(deleteNotebookMessage("Scratch", 0)).toBe(
      "“Scratch” has no runs. You can restore it later."
    );
  });
});

describe("notebooksEmptyMessage", () => {
  it("invites the first lab notebook when there's no search", () => {
    expect(notebooksEmptyMessage("  ")).toMatch(/^No lab notebooks yet\./);
  });

  it("says no lab notebook has a pasted page", () => {
    expect(notebooksEmptyMessage(NOTION_URL)).toBe(
      "No lab notebook has this page yet. Create one with New lab notebook."
    );
  });

  it("says nothing matched a text search", () => {
    expect(notebooksEmptyMessage("growth")).toBe(
      "No lab notebooks match your search."
    );
  });
});

describe("suggestedNotebookName", () => {
  it("names a new lab notebook after its page", () => {
    expect(suggestedNotebookName(`  ${NOTION_URL} `)).toBe("Heat stress day 1");
  });

  it("suggests nothing until the link is one Data Hub accepts", () => {
    expect(suggestedNotebookName("")).toBe("");
    expect(suggestedNotebookName("notion.so/lab/page")).toBe("");
    expect(suggestedNotebookName("ftp://example.com/page")).toBe("");
  });
});

describe("notebookFieldErrors", () => {
  it("passes a link, a name, and no description", () => {
    expect(
      notebookFieldErrors({ url: NOTION_URL, name: "Growth", description: "" })
    ).toEqual({});
  });

  it("asks for a link and a name", () => {
    expect(
      notebookFieldErrors({ url: " ", name: " ", description: "" })
    ).toEqual({ url: "Enter a link.", name: "Enter a name." });
  });

  it("explains a link that isn't http or https, and a name that's too long", () => {
    const errors = notebookFieldErrors({
      url: "javascript:alert(1)",
      name: "x".repeat(NOTEBOOK_NAME_MAX_LENGTH + 1),
      description: "",
    });
    expect(errors.url).toBe(
      "Enter a link that starts with http:// or https://."
    );
    expect(errors.name).toBe(
      `Names can be at most ${NOTEBOOK_NAME_MAX_LENGTH} characters.`
    );
  });
});

describe("initialOwnerChoice", () => {
  it("tells the viewer, someone else, and nobody apart", () => {
    expect(initialOwnerChoice("user-1", "user-1")).toBe("me");
    expect(initialOwnerChoice("user-2", "user-1")).toBe("current");
    expect(initialOwnerChoice(null, "user-1")).toBe("none");
  });
});

describe("notebookEditPatch", () => {
  const initial = {
    name: "Growth curves",
    description: "Week 3",
    url: NOTION_URL,
    owner: "current" as const,
  };
  const unchanged = {
    name: "Growth curves",
    description: "Week 3",
    url: NOTION_URL,
    owner: "current" as const,
  };

  it("sends nothing when nothing changed, ignoring surrounding spaces", () => {
    expect(notebookEditPatch(initial, unchanged)).toEqual({});
    expect(
      notebookEditPatch(initial, {
        ...unchanged,
        name: " Growth curves ",
        description: "Week 3  ",
        url: ` ${NOTION_URL}`,
      })
    ).toEqual({});
  });

  it("sends only the fields that changed, trimmed", () => {
    expect(
      notebookEditPatch(initial, { ...unchanged, name: " Growth curves v2 " })
    ).toEqual({ name: "Growth curves v2" });
    expect(
      notebookEditPatch(initial, {
        ...unchanged,
        url: "https://example.com/lab/entry-9",
      })
    ).toEqual({ url: "https://example.com/lab/entry-9" });
  });

  it("clears a description that was emptied, and sets one that was added", () => {
    expect(
      notebookEditPatch(initial, { ...unchanged, description: "  " })
    ).toEqual({ description: null });
    expect(
      notebookEditPatch(
        { ...initial, description: null },
        { ...unchanged, description: "New notes" }
      )
    ).toEqual({ description: "New notes" });
    expect(
      notebookEditPatch(
        { ...initial, description: null },
        { ...unchanged, description: "" }
      )
    ).toEqual({});
  });

  it("makes the viewer the owner, or clears the owner", () => {
    expect(notebookEditPatch(initial, { ...unchanged, owner: "me" })).toEqual({
      owner_id: "me",
    });
    expect(notebookEditPatch(initial, { ...unchanged, owner: "none" })).toEqual(
      { owner_id: null }
    );
    expect(
      notebookEditPatch(
        { ...initial, owner: "me" },
        { ...unchanged, owner: "me" }
      )
    ).toEqual({});
  });
});
