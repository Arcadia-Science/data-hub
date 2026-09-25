import { notFound } from "next/navigation";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import {
  CommentListSkeleton,
  CommentPreviewPanel,
} from "@/components/comments/comment-list";
import { CommentScopeFilter } from "@/components/comments/comment-scope-filter";
import { CommentTabs } from "@/components/comments/comment-tabs";
import {
  MyRunsStatsCards,
  MyRunsStatsCardsSkeleton,
} from "@/components/dashboard/dashboard-stats";
import {
  DashboardRunsSkeleton,
  RunsTable,
} from "@/components/dashboard/runs-table";
import { RunsToolbar } from "@/components/dashboard/runs-toolbar";
import { RunBulkActionBar } from "@/components/instruments/runs-table/run-bulk-action-bar";
import { RunSelectionProvider } from "@/components/instruments/runs-table/run-selection-provider";
import { PaginationNav } from "@/components/pagination-nav";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
import { UserAvatar } from "@/components/user-avatar";
import {
  getInstruments,
  getMyRunsStats,
  getUserProfile,
  type UserProfile,
} from "@/lib/api/dashboard";
import { buildRunListQuery } from "@/lib/api/instrument-runs";
import { listCommentFeed } from "@/lib/api/run-comments";
import { auth } from "@/lib/auth";
import {
  onRunsEmptyLabel,
  onRunsLabel,
  writtenByEmptyLabel,
  writtenByLabel,
} from "@/lib/comments/labels";
import { possessive } from "@/lib/display-name";
import { dashboardParamsCache, hasActiveFilters } from "@/lib/search-params";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

type DashboardParams = Awaited<ReturnType<typeof dashboardParamsCache.parse>>;

interface Props {
  params: Promise<{ userId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { userId } = await params;
  const profile = await getUserProfile(userId);
  if (!profile) {
    return { title: "User not found" };
  }

  const title = profile.displayName;
  const description = `Runs and comments for ${profile.displayName}.`;

  return {
    title,
    description,
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export default async function UserRunsPage({ params, searchParams }: Props) {
  const session = await auth();
  const { userId } = await params;

  if (!session) {
    return (
      <SignInRequired callbackUrl={`/users/${userId}`}>
        Sign in to view runs.
      </SignInRequired>
    );
  }

  const profile = await getUserProfile(userId);
  if (!profile) {
    notFound();
  }

  const dashboardParams = dashboardParamsCache.parse(await searchParams);
  const isSelf = session.user.id === userId;

  // Each section fetches its own data behind a Suspense boundary so the static
  // shell paints immediately and the stats + runs stream in independently.
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 2xl:w-6xl">
      <section className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <UserAvatar size="lg" user={profile} />
          <h1 className="font-medium text-2xl tracking-tight">
            {profile.displayName}
          </h1>
        </div>
        <Suspense fallback={<MyRunsStatsCardsSkeleton />}>
          <UserRunsStatsSection isSelf={isSelf} profile={profile} />
        </Suspense>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-lg tracking-tight">
          Recent instrument runs
        </h2>
        <Suspense fallback={<DashboardRunsSkeleton />}>
          <UserRunsSection
            isSelf={isSelf}
            params={dashboardParams}
            profile={profile}
          />
        </Suspense>
      </section>

      <section className="flex flex-col gap-3">
        <CommentTabs defaultValue="written" values={["written", "on_runs"]}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-pretty font-medium text-lg tracking-tight">
              Recent comments
            </h2>
            <CommentScopeFilter
              defaultValue="written"
              options={[
                {
                  label: writtenByLabel(profile.displayName, isSelf),
                  value: "written",
                },
                {
                  label: onRunsLabel(profile.displayName, isSelf),
                  value: "on_runs",
                },
              ]}
              values={["written", "on_runs"]}
            />
          </div>
          <Suspense fallback={<CommentListSkeleton />}>
            <ProfileCommentPanels isSelf={isSelf} profile={profile} />
          </Suspense>
        </CommentTabs>
      </section>
    </div>
  );
}

async function UserRunsStatsSection({
  profile,
  isSelf,
}: {
  profile: UserProfile;
  isSelf: boolean;
}) {
  const stats = await getMyRunsStats(profile.userId);
  const commentsLabel = isSelf
    ? undefined
    : `Comments on ${possessive(profile.displayName)} runs`;
  return <MyRunsStatsCards commentsLabel={commentsLabel} stats={stats} />;
}

async function UserRunsSection({
  params,
  profile,
  isSelf,
}: {
  params: DashboardParams;
  profile: UserProfile;
  isSelf: boolean;
}) {
  const instrumentIds =
    params.instrument_id.length > 0 ? params.instrument_id : undefined;

  // The toolbar instrument list and the filtered run page are independent.
  // Runs are scoped to this user via `ranBy`, so the URL `ran_by` param (which
  // the dashboard toolbar never sets here) is intentionally ignored.
  const [instruments, runResult] = await Promise.all([
    getInstruments(true),
    buildRunListQuery({
      ranBy: profile.userId,
      instrumentId: instrumentIds,
      search: params.search || undefined,
      dateFrom: params.date_from ?? undefined,
      dateTo: params.date_to ?? undefined,
      page: params.page,
      perPage: params.per_page,
      includeDeleted: params.include_deleted,
      statuses: params.status.length > 0 ? params.status : undefined,
      sort: params.sort,
      order: params.order,
    }),
  ]);

  const hasFilters = hasActiveFilters(params);

  const emptyLabel = isSelf
    ? "No runs attributed to you yet."
    : `No runs attributed to ${profile.displayName} yet.`;

  return (
    <RunSelectionProvider>
      <TablePendingProvider>
        <div className="flex flex-col gap-3">
          <RunsToolbar instruments={instruments} />
          <RunBulkActionBar />
          <TablePendingBoundary>
            <RunsTable
              data={runResult.data}
              emptyLabel={emptyLabel}
              hasFilters={hasFilters}
              totalCount={runResult.pagination.total}
            />
          </TablePendingBoundary>
          <PaginationNav
            page={runResult.pagination.page}
            pageParam="page"
            totalPages={runResult.pagination.total_pages}
          />
        </div>
      </TablePendingProvider>
    </RunSelectionProvider>
  );
}

const PROFILE_COMMENTS_LIMIT = 4;

async function ProfileCommentPanels({
  profile,
  isSelf,
}: {
  profile: UserProfile;
  isSelf: boolean;
}) {
  const [written, onRuns, timeZone] = await Promise.all([
    listCommentFeed({
      authorId: profile.userId,
      count: false,
      perPage: PROFILE_COMMENTS_LIMIT,
    }),
    listCommentFeed({
      count: false,
      perPage: PROFILE_COMMENTS_LIMIT,
      ranBy: profile.userId,
    }),
    getViewerTimeZone(),
  ]);

  return (
    <>
      <CommentPreviewPanel
        comments={written.data}
        emptyLabel={writtenByEmptyLabel(profile.displayName, isSelf)}
        href={`/comments?author=${encodeURIComponent(profile.userId)}`}
        timeZone={timeZone}
        value="written"
      />
      <CommentPreviewPanel
        comments={onRuns.data}
        emptyLabel={onRunsEmptyLabel(profile.displayName, isSelf)}
        href={`/comments?ran_by=${encodeURIComponent(profile.userId)}`}
        timeZone={timeZone}
        value="on_runs"
      />
    </>
  );
}
