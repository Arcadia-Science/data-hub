import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/api/actor";
import { deletedBanner, deletedTooltip } from "@/lib/runs/deleted-file-note";

// 10:42 AM on Nov 19 in New York.
const deletedAt = new Date("2026-11-19T15:42:00Z");
const zone = "America/New_York";

const person: Actor = {
  kind: "user",
  user: {
    userId: "u1",
    displayName: "Ada Lovelace",
    initials: "AL",
    avatarUrl: null,
  },
};
const token: Actor = {
  kind: "token",
  token: { id: "t1", name: "cleanup-script", revoked: false },
};

describe("deletedTooltip", () => {
  it("names the person, the date, and the time", () => {
    expect(deletedTooltip({ deleter: person, deletedAt }, zone)).toBe(
      "Deleted by Ada Lovelace on Nov 19, 2026 at 10:42 AM"
    );
  });

  it("names the token for a token", () => {
    expect(deletedTooltip({ deleter: token, deletedAt }, zone)).toBe(
      "Deleted by cleanup-script on Nov 19, 2026 at 10:42 AM"
    );
  });

  it("gives only the date when nobody was recorded", () => {
    expect(deletedTooltip({ deleter: null, deletedAt }, zone)).toBe(
      "Deleted on Nov 19, 2026"
    );
  });

  it("reads the time in the viewer's zone", () => {
    expect(
      deletedTooltip({ deleter: person, deletedAt }, "America/Los_Angeles")
    ).toBe("Deleted by Ada Lovelace on Nov 19, 2026 at 7:42 AM");
  });
});

describe("deletedBanner", () => {
  it("says who deleted the file and when, and nothing more", () => {
    expect(deletedBanner({ deleter: person, deletedAt }, zone)).toBe(
      "Ada Lovelace deleted this file on Nov 19, 2026 at 10:42 AM."
    );
  });

  it("falls back to a sentence with no name", () => {
    expect(deletedBanner({ deleter: null, deletedAt }, zone)).toBe(
      "This file was deleted on Nov 19, 2026."
    );
  });
});
