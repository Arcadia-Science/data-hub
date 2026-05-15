import { db } from "@/lib/db";
import { runComments, users } from "@/lib/db/schema";
import { toInitials } from "@/lib/utils";
import { and, asc, eq, isNull } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Run comments — markdown notes left by users on an instrument run.
//
// All mutations are author-only, enforced both by the SQL `where` clause
// (defense in depth) and by the route handler (which can return a clean
// 403 vs 404 distinction). Reads are open to any authenticated user.
// ---------------------------------------------------------------------------

export type RunCommentDto = {
  id: string;
  body: string;
  user: {
    id: string;
    displayName: string;
    initials: string;
    avatarUrl: string | null;
  };
  created_at: Date;
  edited_at: Date | null;
};

function toDto(row: {
  id: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
}): RunCommentDto {
  const displayName = row.userName ?? row.userEmail ?? "Unknown";
  return {
    id: row.id,
    body: row.body,
    user: {
      id: row.userId,
      displayName,
      initials: toInitials(displayName),
      avatarUrl: row.userImage,
    },
    created_at: row.createdAt,
    edited_at: row.editedAt,
  };
}

// ---------------------------------------------------------------------------
// List — chronological, oldest first (matches conversational reading order).
// Joins the user table once so the wire shape is render-ready and clients
// don't need a follow-up users lookup per comment.
// ---------------------------------------------------------------------------

export async function listCommentsForRun(
  runInternalId: string
): Promise<RunCommentDto[]> {
  const rows = await db
    .select({
      id: runComments.id,
      body: runComments.body,
      createdAt: runComments.createdAt,
      editedAt: runComments.editedAt,
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      userImage: users.image,
    })
    .from(runComments)
    .innerJoin(users, eq(users.id, runComments.userId))
    .where(
      and(eq(runComments.runId, runInternalId), isNull(runComments.deletedAt))
    )
    .orderBy(asc(runComments.createdAt));

  return rows.map(toDto);
}

// ---------------------------------------------------------------------------
// Create — caller is responsible for body validation (length / non-empty).
// Returns the rendered DTO so the API can echo it back to the client.
// ---------------------------------------------------------------------------

export async function createComment(input: {
  runInternalId: string;
  userId: string;
  body: string;
}): Promise<RunCommentDto> {
  const [inserted] = await db
    .insert(runComments)
    .values({
      runId: input.runInternalId,
      userId: input.userId,
      body: input.body,
    })
    .returning({
      id: runComments.id,
      body: runComments.body,
      createdAt: runComments.createdAt,
      editedAt: runComments.editedAt,
    });

  // Fetch the joined user row so the DTO is consistent with `listCommentsForRun`.
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  return toDto({
    id: inserted.id,
    body: inserted.body,
    createdAt: inserted.createdAt,
    editedAt: inserted.editedAt,
    userId: input.userId,
    userName: user?.name ?? null,
    userEmail: user?.email ?? null,
    userImage: user?.image ?? null,
  });
}

// ---------------------------------------------------------------------------
// Lookup — used by routes to distinguish 404 (missing/soft-deleted) from
// 403 (exists but caller is not the author).
// ---------------------------------------------------------------------------

export async function getCommentForAuthorCheck(
  commentId: string
): Promise<{ id: string; userId: string; runId: string } | null> {
  const [row] = await db
    .select({
      id: runComments.id,
      userId: runComments.userId,
      runId: runComments.runId,
    })
    .from(runComments)
    .where(and(eq(runComments.id, commentId), isNull(runComments.deletedAt)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Update — author-only via the `where` clause. Returns null if nothing
// matched (caller has already distinguished 404 vs 403 via the lookup).
// Sets `editedAt` so the UI can render an "edited" affordance.
// ---------------------------------------------------------------------------

export async function updateComment(input: {
  commentId: string;
  userId: string;
  body: string;
}): Promise<RunCommentDto | null> {
  const now = new Date();
  const updated = await db
    .update(runComments)
    .set({ body: input.body, editedAt: now })
    .where(
      and(
        eq(runComments.id, input.commentId),
        eq(runComments.userId, input.userId),
        isNull(runComments.deletedAt)
      )
    )
    .returning({
      id: runComments.id,
      body: runComments.body,
      createdAt: runComments.createdAt,
      editedAt: runComments.editedAt,
      userId: runComments.userId,
    });

  if (updated.length === 0) return null;
  const row = updated[0];

  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);

  return toDto({
    id: row.id,
    body: row.body,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    userId: row.userId,
    userName: user?.name ?? null,
    userEmail: user?.email ?? null,
    userImage: user?.image ?? null,
  });
}

// ---------------------------------------------------------------------------
// Soft-delete — author-only. Idempotent: a row already soft-deleted will
// not match the `isNull(deletedAt)` predicate, so this returns false.
// ---------------------------------------------------------------------------

export async function softDeleteComment(input: {
  commentId: string;
  userId: string;
}): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(runComments)
    .set({ deletedAt: now })
    .where(
      and(
        eq(runComments.id, input.commentId),
        eq(runComments.userId, input.userId),
        isNull(runComments.deletedAt)
      )
    )
    .returning({ id: runComments.id });
  return result.length > 0;
}
