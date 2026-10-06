import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/api/actor";
import { commentPermissions } from "@/lib/comments/permissions";

const byUser = (userId: string): { author: Actor } => ({
  author: {
    kind: "user",
    user: { userId, displayName: "Ada", initials: "A", avatarUrl: null },
  },
});

const byToken = (): { author: Actor } => ({
  author: { kind: "token", token: { id: "t1", name: "Bot", revoked: false } },
});

describe("commentPermissions", () => {
  it("lets the author edit and delete", () => {
    expect(
      commentPermissions(byUser("u1"), { userId: "u1", isAdmin: false })
    ).toEqual({ canEdit: true, canDelete: true });
  });

  it("gives another member no controls", () => {
    expect(
      commentPermissions(byUser("u1"), { userId: "u2", isAdmin: false })
    ).toEqual({ canEdit: false, canDelete: false });
  });

  it("lets an admin delete but not edit someone else's comment", () => {
    expect(
      commentPermissions(byUser("u1"), { userId: "u2", isAdmin: true })
    ).toEqual({ canEdit: false, canDelete: true });
  });

  it("lets an admin delete a comment a token posted, but never edit it", () => {
    expect(
      commentPermissions(byToken(), { userId: "u2", isAdmin: true })
    ).toEqual({ canEdit: false, canDelete: true });
  });

  it("gives a member no controls on a token's comment", () => {
    expect(
      commentPermissions(byToken(), { userId: "u2", isAdmin: false })
    ).toEqual({ canEdit: false, canDelete: false });
  });

  it("gives a signed-out viewer no controls", () => {
    expect(
      commentPermissions(byUser("u1"), { userId: null, isAdmin: false })
    ).toEqual({ canEdit: false, canDelete: false });
  });
});
