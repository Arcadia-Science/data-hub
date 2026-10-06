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
import {
  type Actor,
  type ActorRef,
  actorColumns,
  resolveActor,
} from "@/lib/api/actor";
import { attributedToUser } from "@/lib/api/attributions";
import { notifyComment } from "@/lib/api/notifications";
import { touchRuns } from "@/lib/api/touch-runs";
import { db } from "@/lib/db";
import {
  instrumentRuns,
  instruments,
  personalAccessTokens,
  runComments,
  users,
} from "@/lib/db/schema";

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
  // A person, or a personal access token that posted through the API.
  author: Actor;
  body: string;
  created_at: Date;
  edited_at: Date | null;
  id: string;
}

// Shared by every comment query: both author tables are left joined, since
// exactly one of `user_id` / `token_id` is set on a comment.
const commentRowColumns = {
  id: runComments.id,
  body: runComments.body,
  createdAt: runComments.createdAt,
  editedAt: runComments.editedAt,
  userId: users.id,
  userName: users.name,
  userEmail: users.email,
  userImage: users.image,
  tokenId: personalAccessTokens.id,
  tokenName: personalAccessTokens.name,
  tokenRevokedAt: personalAccessTokens.revokedAt,
};

function toDto(row: {
  id: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
  tokenId: string | null;
  tokenName: string | null;
  tokenRevokedAt: Date | null;
}): RunCommentDto {
  // The database guarantees one author; the fallback only covers a row read
  // mid-delete.
  const author = resolveActor(row) ?? {
    kind: "user" as const,
    user: {
      userId: "unknown",
      displayName: "Unknown",
      initials: "?",
      avatarUrl: null,
    },
  };
  return {
    id: row.id,
    body: row.body,
    author,
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
    .select(commentRowColumns)
    .from(runComments)
    .leftJoin(users, eq(users.id, runComments.userId))
    .leftJoin(
      personalAccessTokens,
      eq(personalAccessTokens.id, runComments.tokenId)
    )
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
      ...commentRowColumns,
      instrumentId: instruments.id,
      instrumentDisplayName: instruments.displayName,
      runDisplayId: instrumentRuns.runId,
    })
    .from(runComments)
    .innerJoin(instrumentRuns, eq(runComments.runId, instrumentRuns.id))
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    .leftJoin(users, eq(runComments.userId, users.id))
    .leftJoin(
      personalAccessTokens,
      eq(personalAccessTokens.id, runComments.tokenId)
    )
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

// Reads one comment through the same joins as `listCommentsForRun`, so the
// DTO a write returns matches what a later read shows.
async function loadComment(commentId: string): Promise<RunCommentDto | null> {
  const [row] = await db
    .select(commentRowColumns)
    .from(runComments)
    .leftJoin(users, eq(users.id, runComments.userId))
    .leftJoin(
      personalAccessTokens,
      eq(personalAccessTokens.id, runComments.tokenId)
    )
    .where(eq(runComments.id, commentId))
    .limit(1);
  return row ? toDto(row) : null;
}

// Matches the comment's author column to the actor: a person's comments carry
// `user_id`, a token's carry `token_id`.
function writtenBy(actor: ActorRef) {
  return actor.kind === "user"
    ? eq(runComments.userId, actor.userId)
    : eq(runComments.tokenId, actor.tokenId);
}

// True when `actor` wrote the comment described by a lookup row. Handlers use
// this to answer 403 before calling the author-scoped update or delete.
export function commentWrittenBy(
  comment: { userId: string | null; tokenId: string | null },
  actor: ActorRef
): boolean {
  return actor.kind === "user"
    ? comment.userId === actor.userId
    : comment.tokenId === actor.tokenId;
}

export async function createComment(input: {
  runInternalId: string;
  actor: ActorRef;
  body: string;
}): Promise<RunCommentDto> {
  const { userId, tokenId } = actorColumns(input.actor);
  const [inserted] = await db
    .insert(runComments)
    .values({
      runId: input.runInternalId,
      userId,
      tokenId,
      body: input.body,
    })
    .returning({ id: runComments.id });
  await touchRuns([input.runInternalId]);

  const created = await loadComment(inserted.id);
  if (!created) {
    throw new Error(`Comment ${inserted.id} missing right after insert`);
  }
  return created;
}

// Shared by REST POST comments and MCP `add_run_comment`: create the row,
// then defer Slack/in-app fan-out with `after()` so serverless freezes don't
// drop the promise. Callers supply `origin` when they have a request URL
// (REST) or a production host env (MCP).
export async function createCommentAndNotify(input: {
  runInternalId: string;
  actor: ActorRef;
  body: string;
  instrumentId: string;
  instrumentDisplayName: string;
  runDisplayId: string;
  origin?: string;
}): Promise<RunCommentDto> {
  const comment = await createComment({
    runInternalId: input.runInternalId,
    actor: input.actor,
    body: input.body,
  });

  after(async () => {
    await notifyComment({
      runInternalId: input.runInternalId,
      commentId: comment.id,
      author: input.actor,
      authorDisplayName:
        comment.author.kind === "user"
          ? comment.author.user.displayName
          : comment.author.token.name,
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

export async function getCommentForAuthorCheck(commentId: string): Promise<{
  id: string;
  userId: string | null;
  tokenId: string | null;
  runId: string;
} | null> {
  const [row] = await db
    .select({
      id: runComments.id,
      userId: runComments.userId,
      tokenId: runComments.tokenId,
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
): Promise<{
  id: string;
  userId: string | null;
  tokenId: string | null;
  deletedAt: Date | null;
} | null> {
  const [row] = await db
    .select({
      id: runComments.id,
      userId: runComments.userId,
      tokenId: runComments.tokenId,
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
  actor: ActorRef;
  body: string;
}): Promise<RunCommentDto | null> {
  const now = new Date();
  const updated = await db
    .update(runComments)
    .set({ body: input.body, editedAt: now })
    .where(
      and(
        eq(runComments.id, input.commentId),
        writtenBy(input.actor),
        isNull(runComments.deletedAt)
      )
    )
    .returning({ id: runComments.id, runId: runComments.runId });

  if (updated.length === 0) {
    return null;
  }
  await touchRuns([updated[0].runId]);
  return await loadComment(updated[0].id);
}

// ---------------------------------------------------------------------------
// Soft-delete — author-only. Idempotent: a row already soft-deleted will
// not match the `isNull(deletedAt)` predicate, so this returns false.
// ---------------------------------------------------------------------------

export async function softDeleteComment(input: {
  commentId: string;
  actor: ActorRef;
}): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(runComments)
    .set({ deletedAt: now })
    .where(
      and(
        eq(runComments.id, input.commentId),
        writtenBy(input.actor),
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
