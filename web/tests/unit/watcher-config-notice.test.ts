import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/api/actor";
import {
  configNoticeKind,
  pendingChangeAuthor,
  rejectionReasonText,
} from "@/lib/watchers/config-notice";

describe("configNoticeKind", () => {
  it("shows Change pending for a pending change", () => {
    expect(configNoticeKind("pending", false)).toBe("pending");
  });

  it("shows Change rejected for a rejected change", () => {
    expect(configNoticeKind("rejected", false)).toBe("rejected");
  });

  it("shows Edited on PC for an edit that waits for a restart", () => {
    expect(configNoticeKind("applied", true)).toBe("edited_on_pc");
    expect(configNoticeKind(null, true)).toBe("edited_on_pc");
  });

  it("shows nothing for applied settings or none at all", () => {
    expect(configNoticeKind("applied", false)).toBeNull();
    expect(configNoticeKind(null, false)).toBeNull();
    expect(configNoticeKind("superseded", false)).toBeNull();
  });

  it("puts a pending or rejected change before an edit on the PC", () => {
    expect(configNoticeKind("pending", true)).toBe("pending");
    expect(configNoticeKind("rejected", true)).toBe("rejected");
  });
});

function person(userId: string, displayName: string): Actor {
  return {
    kind: "user",
    user: { userId, displayName, initials: "AE", avatarUrl: null },
  };
}

describe("pendingChangeAuthor", () => {
  it("says You when the viewer saved the change", () => {
    expect(pendingChangeAuthor(person("u1", "Alice Example"), "u1")).toBe(
      "You"
    );
  });

  it("names another person", () => {
    expect(pendingChangeAuthor(person("u1", "Alice Example"), "u2")).toBe(
      "Alice Example"
    );
  });

  it("names a token that saved the change", () => {
    const token: Actor = {
      kind: "token",
      token: { id: "t1", name: "Lab PC token", revoked: false },
    };
    expect(pendingChangeAuthor(token, "u1")).toBe("Lab PC token");
  });

  it("says Someone when no one was recorded", () => {
    expect(pendingChangeAuthor(null, "u1")).toBe("Someone");
  });
});

describe("rejectionReasonText", () => {
  it("returns the reason as the watcher gave it", () => {
    expect(rejectionReasonText("Folder not found: D:\\Exports")).toBe(
      "Folder not found: D:\\Exports"
    );
  });

  it("drops trailing full stops and spaces, so the sentence doesn't end in ..", () => {
    expect(rejectionReasonText("  The folder doesn't exist.  ")).toBe(
      "The folder doesn't exist"
    );
    expect(rejectionReasonText("Not readable...")).toBe("Not readable");
  });

  it("is empty when the watcher gave no reason", () => {
    expect(rejectionReasonText(null)).toBe("");
    expect(rejectionReasonText("   ")).toBe("");
  });
});
