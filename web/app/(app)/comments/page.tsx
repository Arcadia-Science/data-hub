import { formatInTimeZone } from "date-fns-tz";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import {
  type CommentFeedEntry,
  CommentFeedList,
  CommentFeedSkeleton,
} from "@/components/comments/comment-feed-list";
import {
  CommentFilterTabs,
  CommentPersonFilter,
} from "@/components/comments/comment-filter-tabs";
import { PaginationNav } from "@/components/pagination-nav";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
import { getUserProfile, type UserProfile } from "@/lib/api/dashboard";
import { type CommentFeedItem, listCommentFeed } from "@/lib/api/run-comments";
import { auth } from "@/lib/auth";
import { groupCommentsByDay } from "@/lib/comments/group-by-day";
import {
  onRunsEmptyLabel,
  onRunsLabel,
  writtenByEmptyLabel,
  writtenByLabel,
} from "@/lib/comments/labels";
import { commentsParamsCache } from "@/lib/search-params";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

export const metadata: Metadata = {
  title: "Comments",
  description: "Recent comments across instrument runs.",
};

const COMMENTS_PER_PAGE = 20;

export default async function CommentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session) {
    return (
      <SignInRequired callbackUrl="/comments">
        Sign in to view comments.
      </SignInRequired>
    );
  }

  const params = commentsParamsCache.parse(await searchParams);
  const currentUserId = session.user.id;
  const active = params.author
    ? null
    : params.ran_by === currentUserId
      ? "mine"
      : params.ran_by
        ? null
        : "all";
  // Resolve a person filter before streaming. `notFound()` inside the
  // Suspense child would already have sent a 200.
  const personId =
    params.author ??
    (params.ran_by && params.ran_by !== currentUserId ? params.ran_by : null);
  const person = personId ? await getUserProfile(personId) : null;
  if (personId && !person) {
    notFound();
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6 2xl:w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-pretty font-medium text-2xl tracking-tight">
          Comments
        </h1>
        <CommentFilterTabs active={active} currentUserId={currentUserId} />
      </div>
      <Suspense
        fallback={<CommentFeedSkeleton />}
        key={`${params.author ?? ""}:${params.ran_by ?? ""}`}
      >
        <CommentsFeed
          authorId={params.author}
          currentUserId={currentUserId}
          page={params.page}
          person={person}
          ranBy={params.ran_by}
        />
      </Suspense>
    </div>
  );
}

function stampTimes(
  comments: CommentFeedItem[],
  timeZone: string
): CommentFeedEntry[] {
  return comments.map((comment) => ({
    ...comment,
    createdAtIso: comment.created_at.toISOString(),
    timeLabel: formatInTimeZone(comment.created_at, timeZone, "h:mm a"),
    timeFull: formatInTimeZone(
      comment.created_at,
      timeZone,
      "MMM d, yyyy h:mm a"
    ),
  }));
}

async function CommentsFeed({
  authorId,
  currentUserId,
  page,
  person,
  ranBy,
}: {
  authorId: string | null;
  currentUserId: string;
  page: number;
  person: UserProfile | null;
  ranBy: string | null;
}) {
  const [feed, timeZone] = await Promise.all([
    listCommentFeed({
      authorId: authorId ?? undefined,
      page,
      perPage: COMMENTS_PER_PAGE,
      ranBy: ranBy ?? undefined,
    }),
    getViewerTimeZone(),
  ]);

  let filterLabel: string | null = null;
  let emptyLabel = "No comments yet.";
  if (person && authorId) {
    const self = person.userId === currentUserId;
    filterLabel = writtenByLabel(person.displayName, self);
    emptyLabel = writtenByEmptyLabel(person.displayName, self);
  } else if (person) {
    const self = person.userId === currentUserId;
    filterLabel = onRunsLabel(person.displayName, self);
    emptyLabel = onRunsEmptyLabel(person.displayName, self);
  } else if (ranBy === currentUserId) {
    emptyLabel = onRunsEmptyLabel("", true);
  }

  const sections = groupCommentsByDay(
    stampTimes(feed.data, timeZone),
    timeZone
  );

  return (
    <TablePendingProvider>
      <div className="flex flex-col gap-4">
        {filterLabel ? <CommentPersonFilter label={filterLabel} /> : null}
        <TablePendingBoundary>
          <CommentFeedList emptyLabel={emptyLabel} sections={sections} />
        </TablePendingBoundary>
        <PaginationNav
          page={feed.pagination.page}
          pageParam="page"
          totalPages={feed.pagination.total_pages}
        />
      </div>
    </TablePendingProvider>
  );
}
