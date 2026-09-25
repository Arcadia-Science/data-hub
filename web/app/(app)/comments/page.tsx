import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import {
  CommentFeedList,
  CommentFeedSkeleton,
} from "@/components/comments/comment-feed-list";
import {
  CommentFilterSkeleton,
  CommentFilters,
} from "@/components/comments/comment-filters";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
import { getUserProfile, type UserProfile } from "@/lib/api/dashboard";
import { listCommentFeed } from "@/lib/api/run-comments";
import { auth } from "@/lib/auth";
import {
  formatCommentDayHeading,
  groupCommentsByDay,
} from "@/lib/comments/group-by-day";
import { commentsPath } from "@/lib/comments/href";
import {
  onRunsEmptyLabel,
  onRunsLabel,
  writtenByEmptyLabel,
  writtenByLabel,
} from "@/lib/comments/labels";
import { toCommentRow } from "@/lib/comments/present";
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
  // Resolve a person filter before streaming. `notFound()` inside the
  // Suspense child would already have sent a 200.
  const personId =
    params.author ??
    (params.ran_by && params.ran_by !== currentUserId ? params.ran_by : null);
  const person = personId ? await getUserProfile(personId) : null;
  if (personId && !person) {
    notFound();
  }

  const { emptyLabel, personLabel } = commentScopeCopy(
    person,
    params.author,
    params.ran_by,
    currentUserId
  );
  const feedKey = `${params.author ?? ""}:${params.ran_by ?? ""}`;

  return (
    <TablePendingProvider>
      <div className="p-6">
        <div className="mx-auto grid w-full max-w-[1040px] grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_272px] lg:gap-x-12">
          <h1 className="font-medium text-2xl tracking-tight lg:col-start-1 lg:row-start-1">
            Comments
          </h1>
          <aside aria-label="Filters" className="lg:col-start-2 lg:row-start-2">
            <Suspense fallback={<CommentFilterSkeleton />} key={feedKey}>
              <CommentFilters
                authorId={params.author}
                currentUserId={currentUserId}
                includeIds={params.instrument_id}
                personLabel={personLabel}
                ranBy={params.ran_by}
              />
            </Suspense>
          </aside>
          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            <Suspense fallback={<CommentFeedSkeleton />} key={feedKey}>
              <CommentsFeed
                authorId={params.author}
                emptyLabel={emptyLabel}
                instrumentIds={params.instrument_id}
                page={params.page}
                ranBy={params.ran_by}
              />
            </Suspense>
          </div>
        </div>
      </div>
    </TablePendingProvider>
  );
}

function commentScopeCopy(
  person: UserProfile | null,
  authorId: string | null,
  ranBy: string | null,
  currentUserId: string
): { emptyLabel: string; personLabel: string | null } {
  if (person && authorId) {
    const self = person.userId === currentUserId;
    return {
      emptyLabel: writtenByEmptyLabel(person.displayName, self),
      personLabel: writtenByLabel(person.displayName, self),
    };
  }
  if (person) {
    const self = person.userId === currentUserId;
    return {
      emptyLabel: onRunsEmptyLabel(person.displayName, self),
      personLabel: onRunsLabel(person.displayName, self),
    };
  }
  if (ranBy === currentUserId) {
    return {
      emptyLabel: onRunsEmptyLabel("", true),
      personLabel: null,
    };
  }
  return { emptyLabel: "No comments yet.", personLabel: null };
}

async function CommentsFeed({
  authorId,
  emptyLabel,
  instrumentIds,
  page,
  ranBy,
}: {
  authorId: string | null;
  emptyLabel: string;
  instrumentIds: string[];
  page: number;
  ranBy: string | null;
}) {
  const [feed, timeZone] = await Promise.all([
    listCommentFeed({
      authorId: authorId ?? undefined,
      instrumentIds: instrumentIds.length > 0 ? instrumentIds : undefined,
      page,
      perPage: COMMENTS_PER_PAGE,
      ranBy: ranBy ?? undefined,
    }),
    getViewerTimeZone(),
  ]);

  const sections = groupCommentsByDay(
    feed.data.map((comment) => toCommentRow(comment, timeZone)),
    timeZone,
    new Date(),
    formatCommentDayHeading
  );
  const query = {
    author: authorId,
    instrument_id: instrumentIds,
    ran_by: ranBy,
  };

  return (
    <TablePendingBoundary>
      <CommentFeedList
        emptyLabel={emptyLabel}
        newerHref={
          feed.pagination.page > 1
            ? commentsPath({ ...query, page: feed.pagination.page - 1 })
            : null
        }
        olderHref={
          feed.pagination.page < feed.pagination.total_pages
            ? commentsPath({ ...query, page: feed.pagination.page + 1 })
            : null
        }
        sections={sections}
      />
    </TablePendingBoundary>
  );
}
