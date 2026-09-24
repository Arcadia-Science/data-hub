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
import { TablePendingProvider } from "@/components/table-pending";
import { getUserProfile } from "@/lib/api/dashboard";
import { type CommentFeedItem, listCommentFeed } from "@/lib/api/run-comments";
import { auth } from "@/lib/auth";
import { groupCommentsByDay } from "@/lib/comments/group-by-day";
import { commentsParamsCache } from "@/lib/search-params";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

export const metadata: Metadata = {
  title: "Comments",
  description: "Recent comments across instrument runs.",
};

const COMMENTS_PER_PAGE = 20;

function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
}

function possessive(displayName: string): string {
  const name = firstName(displayName);
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

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
        key={`${params.author ?? ""}:${params.ran_by ?? ""}:${params.page}`}
      >
        <CommentsFeed
          authorId={params.author}
          currentUserId={currentUserId}
          page={params.page}
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
  return comments.map((comment) => {
    const created =
      comment.created_at instanceof Date
        ? comment.created_at
        : new Date(comment.created_at);
    return {
      ...comment,
      timeLabel: formatInTimeZone(created, timeZone, "h:mm a"),
      timeFull: formatInTimeZone(created, timeZone, "MMM d, yyyy h:mm a"),
    };
  });
}

async function CommentsFeed({
  authorId,
  currentUserId,
  page,
  ranBy,
}: {
  authorId: string | null;
  currentUserId: string;
  page: number;
  ranBy: string | null;
}) {
  const personId =
    authorId ?? (ranBy && ranBy !== currentUserId ? ranBy : null);
  const [feed, timeZone, person] = await Promise.all([
    listCommentFeed({
      authorId: authorId ?? undefined,
      page,
      perPage: COMMENTS_PER_PAGE,
      ranBy: ranBy ?? undefined,
    }),
    getViewerTimeZone(),
    personId ? getUserProfile(personId) : Promise.resolve(null),
  ]);

  if (personId && !person) {
    notFound();
  }

  let filterLabel: string | null = null;
  let emptyLabel = "No comments yet.";
  if (person && authorId) {
    const self = person.userId === currentUserId;
    filterLabel = self
      ? "Written by you"
      : `Written by ${firstName(person.displayName)}`;
    emptyLabel = self
      ? "You haven't written any comments yet."
      : `${firstName(person.displayName)} hasn't written any comments yet.`;
  } else if (person) {
    const self = person.userId === currentUserId;
    filterLabel = self
      ? "On your runs"
      : `On ${possessive(person.displayName)} runs`;
    emptyLabel = self
      ? "No comments on your runs yet."
      : `No comments on ${possessive(person.displayName)} runs yet.`;
  } else if (ranBy === currentUserId) {
    emptyLabel = "No comments on your runs yet.";
  }

  const sections = groupCommentsByDay(
    stampTimes(feed.data, timeZone),
    timeZone
  );

  return (
    <TablePendingProvider>
      <div className="flex flex-col gap-4">
        {filterLabel ? <CommentPersonFilter label={filterLabel} /> : null}
        <CommentFeedList emptyLabel={emptyLabel} sections={sections} />
        <PaginationNav
          page={feed.pagination.page}
          pageParam="page"
          totalPages={feed.pagination.total_pages}
        />
      </div>
    </TablePendingProvider>
  );
}
