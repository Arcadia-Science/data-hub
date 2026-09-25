import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import { after } from "next/server";
import { attributedToUser } from "@/lib/api/attributions";
import { notifyComment } from "@/lib/api/notifications";
import { touchRuns } from "@/lib/api/touch-runs";
import { db } from "@/lib/db";
import {
  instrumentRuns,
  instruments,
  runComments,
  users,
} from "@/lib/db/schema";
import { toInitials } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Run comments — markdown notes left by users on an instrument run.
//
// All mutations are author-only, enforced both by the SQL `where` clause
// (defense in depth) and by the route handler (which can return a clean
// 403 vs 404 distinction). Reads are open to any authenticated user.
// ---------------------------------------------------------------------------

// Cap shared by REST and MCP. Generous for prose; well below jsonb/text limits.
export const COMMENT_MAX_BODY_LENGTH = 10_000;

export function validateCommentBody(
  body: unknown
): { ok: true; body: string } | { ok: false; message: string } {
  if (typeof body !== "string") {
    return { ok: false, message: "body must be a string" };
  }
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "body must not be empty" };
  }
  if (body.length > COMMENT_MAX_BODY_LENGTH) {
    return {
      ok: false,
      message: `body must be at most ${COMMENT_MAX_BODY_LENGTH} characters`,
    };
  }
  return { ok: true, body };
}

export interface RunCommentDto {
  body: string;
  created_at: Date;
  edited_at: Date | null;
  id: string;
  user: {
    id: string;
    displayName: string;
    initials: string;
    avatarUrl: string | null;
  };
}

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

// Batch counts for the runs list. Kept off the files left-join in
// `buildRunListQuery` so comment rows cannot multiply file aggregates.
export async function getCommentCountsByRunIds(
  runIds: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (runIds.length === 0) {
    return counts;
  }

  const rows = await db
    .select({
      runId: runComments.runId,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(runComments)
    .where(
      and(inArray(runComments.runId, runIds), isNull(runComments.deletedAt))
    )
    .groupBy(runComments.runId);

  for (const row of rows) {
    counts.set(row.runId, row.count);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Cross-run feed — newest first, for the home page, profile pages, and
// `/comments`. Soft-deleted comments and comments on soft-deleted runs are
// excluded; retired instruments stay, matching global search.
// ---------------------------------------------------------------------------

const FEED_DEFAULT_PER_PAGE = 20;
const FEED_MAX_PER_PAGE = 100;

export interface CommentFeedItem extends RunCommentDto {
  run: {
    instrumentDisplayName: string;
    instrumentId: string;
    runId: string;
  };
}

export interface CommentFeedPage {
  data: CommentFeedItem[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}

export interface CommentInstrumentFacet {
  count: number;
  displayName: string;
  id: string;
}

function createdFrom(dateFrom?: string) {
  if (!dateFrom) {
    return;
  }
  const from = new Date(dateFrom);
  if (Number.isNaN(from.getTime())) {
    return;
  }
  return gte(runComments.createdAt, from);
}

// `dateTo` is the start of the last included day. Advance one day so the
// bound includes that whole day, matching the runs list filter.
function createdUntil(dateTo?: string) {
  if (!dateTo) {
    return;
  }
  const end = new Date(dateTo);
  if (Number.isNaN(end.getTime())) {
    return;
  }
  end.setDate(end.getDate() + 1);
  return lte(runComments.createdAt, end);
}

function commentFeedWhere(input: {
  authorId?: string;
  dateFrom?: string;
  dateTo?: string;
  instrumentIds?: string[];
  ranBy?: string;
}) {
  const instrumentIds = (input.instrumentIds ?? []).filter(
    (id) => id.length > 0
  );
  return and(
    isNull(runComments.deletedAt),
    isNull(instrumentRuns.deletedAt),
    input.authorId ? eq(runComments.userId, input.authorId) : undefined,
    input.ranBy ? attributedToUser(input.ranBy) : undefined,
    instrumentIds.length > 0
      ? inArray(instruments.id, instrumentIds)
      : undefined,
    createdFrom(input.dateFrom),
    createdUntil(input.dateTo)
  );
}

export async function listCommentFeed(input: {
  authorId?: string;
  /**
   * Skip the COUNT query. Previews that only render `data` pass `false`.
   * `pagination.total` then equals the page length, not the full result set.
   */
  count?: boolean;
  dateFrom?: string;
  dateTo?: string;
  instrumentIds?: string[];
  page?: number;
  perPage?: number;
  ranBy?: string;
}): Promise<CommentFeedPage> {
  const perPage = Math.min(
    Math.max(input.perPage ?? FEED_DEFAULT_PER_PAGE, 1),
    FEED_MAX_PER_PAGE
  );
  const page = Math.max(input.page ?? 1, 1);
  const offset = (page - 1) * perPage;
  const includeTotal = input.count !== false;

  const where = commentFeedWhere(input);

  const rowsQuery = db
    .select({
      id: runComments.id,
      body: runComments.body,
      createdAt: runComments.createdAt,
      editedAt: runComments.editedAt,
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      userImage: users.image,
      instrumentId: instruments.id,
      instrumentDisplayName: instruments.displayName,
      runDisplayId: instrumentRuns.runId,
    })
    .from(runComments)
    .innerJoin(instrumentRuns, eq(runComments.runId, instrumentRuns.id))
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    .innerJoin(users, eq(runComments.userId, users.id))
    .where(where)
    .orderBy(desc(runComments.createdAt), desc(runComments.id))
    .limit(perPage)
    .offset(offset);

  const totalQuery = db
    .select({ total: sql<number>`cast(count(*) as int)` })
    .from(runComments)
    .innerJoin(instrumentRuns, eq(runComments.runId, instrumentRuns.id))
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    .where(where);

  const [rows, totals] = await Promise.all([
    rowsQuery,
    includeTotal ? totalQuery : Promise.resolve(null),
  ]);

  const total = totals ? (totals[0]?.total ?? 0) : rows.length;

  return {
    data: rows.map((row) => ({
      ...toDto(row),
      run: {
        instrumentId: row.instrumentId,
        instrumentDisplayName: row.instrumentDisplayName,
        runId: row.runDisplayId,
      },
    })),
    pagination: {
      page,
      per_page: perPage,
      total,
      total_pages: includeTotal ? Math.ceil(total / perPage) : 1,
    },
  };
}

// Counts ignore instrument selection so a checked instrument stays listed.
// `includeIds` keeps a zero-count row when the current scope no longer
// matches a selection, so that checkbox can still be cleared.
export async function listCommentInstrumentFacets(input: {
  authorId?: string;
  includeIds?: string[];
  ranBy?: string;
}): Promise<CommentInstrumentFacet[]> {
  const rows = await db
    .select({
      id: instruments.id,
      displayName: instruments.displayName,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(runComments)
    .innerJoin(instrumentRuns, eq(runComments.runId, instrumentRuns.id))
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    .where(commentFeedWhere({ authorId: input.authorId, ranBy: input.ranBy }))
    .groupBy(instruments.id, instruments.displayName);

  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = (input.includeIds ?? []).filter(
    (id) => id.length > 0 && !byId.has(id)
  );
  if (missing.length > 0) {
    const extras = await db
      .select({
        id: instruments.id,
        displayName: instruments.displayName,
      })
      .from(instruments)
      .where(inArray(instruments.id, missing));
    const names = new Map(extras.map((row) => [row.id, row.displayName]));
    for (const id of missing) {
      byId.set(id, {
        id,
        displayName: names.get(id) ?? id,
        count: 0,
      });
    }
  }

  return [...byId.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );
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
  await touchRuns([input.runInternalId]);

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

// Shared by REST POST comments and MCP `add_run_comment`: create the row,
// then defer Slack/in-app fan-out with `after()` so serverless freezes don't
// drop the promise. Callers supply `origin` when they have a request URL
// (REST) or a production host env (MCP).
export async function createCommentAndNotify(input: {
  runInternalId: string;
  userId: string;
  body: string;
  instrumentId: string;
  instrumentDisplayName: string;
  runDisplayId: string;
  origin?: string;
}): Promise<RunCommentDto> {
  const comment = await createComment({
    runInternalId: input.runInternalId,
    userId: input.userId,
    body: input.body,
  });

  after(async () => {
    await notifyComment({
      runInternalId: input.runInternalId,
      commentId: comment.id,
      authorUserId: input.userId,
      authorDisplayName: comment.user.displayName,
      instrumentId: input.instrumentId,
      instrumentDisplayName: input.instrumentDisplayName,
      runDisplayId: input.runDisplayId,
      commentBody: input.body,
      origin: input.origin,
    });
  });

  return comment;
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

// Like `getCommentForAuthorCheck` but includes already soft-deleted rows, so
// the delete path can stay idempotent: re-deleting your own comment still
// resolves the author and succeeds instead of 404-ing on the missing row.
export async function getCommentForDeleteAuthorCheck(
  commentId: string
): Promise<{ id: string; userId: string; deletedAt: Date | null } | null> {
  const [row] = await db
    .select({
      id: runComments.id,
      userId: runComments.userId,
      deletedAt: runComments.deletedAt,
    })
    .from(runComments)
    .where(eq(runComments.id, commentId))
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
      runId: runComments.runId,
    });

  if (updated.length === 0) {
    return null;
  }
  const row = updated[0];
  await touchRuns([row.runId]);

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
    .returning({ id: runComments.id, runId: runComments.runId });
  if (result.length === 0) {
    return false;
  }
  await touchRuns([result[0].runId]);
  return true;
}
