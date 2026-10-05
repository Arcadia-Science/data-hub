import type { Actor } from "@/lib/api/actor";

// What the signed-in viewer may do to a comment. This only decides which
// controls to show: the API re-checks both rules on every request, using the
// database for the admin flag rather than the cached session value.
//
// Edit is author-only, even for admins, so nobody can reword another
// person's comment. Delete also lets admins remove any comment. A comment
// posted by a token has no signed-in author, so only an admin can delete it
// from the browser.
export function commentPermissions(
  comment: { author: Actor },
  viewer: { userId: string | null; isAdmin: boolean }
): { canEdit: boolean; canDelete: boolean } {
  const canEdit =
    viewer.userId !== null &&
    comment.author.kind === "user" &&
    comment.author.user.userId === viewer.userId;
  return { canEdit, canDelete: canEdit || viewer.isAdmin };
}
