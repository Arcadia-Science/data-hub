import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import {
  CommentCardGridSkeleton,
  CommentPreviewPanel,
} from "@/components/comments/comment-card-grid";
import { CommentTabs } from "@/components/comments/comment-tabs";
import {
  DashboardStatsCards,
  StatCardsSkeleton,
} from "@/components/dashboard/dashboard-stats";
import {
  DashboardRunsSkeleton,
  RunsTable,
} from "@/components/dashboard/runs-table";
import { RunsToolbar } from "@/components/dashboard/runs-toolbar";
import {
  InstrumentsTable,
  InstrumentsTableSkeleton,
} from "@/components/instruments/instruments-table";
import { RunBulkActionBar } from "@/components/instruments/runs-table/run-bulk-action-bar";
import { RunSelectionProvider } from "@/components/instruments/runs-table/run-selection-provider";
import { PaginationNav } from "@/components/pagination-nav";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  getDashboardStats,
  getInstruments,
  getTopAttributorThisWeek,
} from "@/lib/api/dashboard";
import {
  buildRunListQuery,
  getRanByFilterOptions,
} from "@/lib/api/instrument-runs";
import { getRecentActiveInstrumentsForDashboard } from "@/lib/api/instruments";
import { listCommentFeed } from "@/lib/api/run-comments";
import { auth } from "@/lib/auth";
import { onRunsEmptyLabel } from "@/lib/comments/labels";
import { startOfTodayISO } from "@/lib/date";
import { dashboardParamsCache, hasActiveFilters } from "@/lib/search-params";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

type DashboardParams = Awaited<ReturnType<typeof dashboardParamsCache.parse>>;

const RECENT_INSTRUMENTS_LIMIT = 3;
const RECENT_COMMENTS_LIMIT = 6;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  // Render the page metadata (title) for unauthenticated visitors so links
  // shared into Notion / Slack still unfurl with a useful title; show a
  // sign-in CTA in the body instead of leaking data. Real users come back
  // here after the Google flow via `callbackUrl`.
  if (!session) {
    return (
      <SignInRequired callbackUrl="/">
        Sign in to view your dashboard.
      </SignInRequired>
    );
  }

  const params = dashboardParamsCache.parse(await searchParams);
  const currentUserId = session.user?.id ?? null;

  // Each section fetches its own data behind a Suspense boundary so the static
  // shell (headings) paints immediately and the three data blocks stream in
  // independently — a slow runs query no longer holds up the stats cards.
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 2xl:w-6xl">
      <Suspense fallback={<StatCardsSkeleton />}>
        <DashboardStatsSection />
      </Suspense>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-lg tracking-tight">Instruments</h2>
        <Suspense
          fallback={
            <InstrumentsTableSkeleton
              footerLabel="View all instruments"
              rows={3}
              withFooter
              withNotifications={false}
            />
          }
        >
          <DashboardInstrumentsSection />
        </Suspense>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-lg tracking-tight">Recent runs</h2>
        <Suspense fallback={<DashboardRunsSkeleton />}>
          <DashboardRunsSection currentUserId={currentUserId} params={params} />
        </Suspense>
      </section>

      <section className="flex flex-col gap-3">
        <CommentTabs defaultValue="all" values={["all", "mine"]}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-pretty font-medium text-lg tracking-tight">
              Recent comments
            </h2>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="mine">On my runs</TabsTrigger>
            </TabsList>
          </div>
          <Suspense fallback={<CommentCardGridSkeleton />}>
            <DashboardCommentPanels currentUserId={currentUserId} />
          </Suspense>
        </CommentTabs>
      </section>
    </div>
  );
}

async function DashboardStatsSection() {
  // The fleet stats and the leaderboard card are independent aggregates.
  const [stats, topAttributor] = await Promise.all([
    getDashboardStats(),
    getTopAttributorThisWeek(),
  ]);
  return <DashboardStatsCards stats={stats} topAttributor={topAttributor} />;
}

async function DashboardInstrumentsSection() {
  // Surface the three most recently active instruments. The focused query
  // returns just those rows + the active total used by the "View all N" link,
  // so we don't fetch the entire fleet to discard the long tail in JS.
  const { rows, totalActive } = await getRecentActiveInstrumentsForDashboard(
    RECENT_INSTRUMENTS_LIMIT
  );

  return (
    <InstrumentsTable
      data={rows}
      footer={
        <Link
          className="flex items-center justify-center gap-1.5 px-4 py-2.5 text-muted-foreground text-sm transition-colors hover:bg-muted/50 hover:text-foreground"
          href="/instruments"
        >
          View all {totalActive} instruments
          <ArrowRight className="size-3.5" />
        </Link>
      }
    />
  );
}

async function DashboardRunsSection({
  currentUserId,
  params,
}: {
  currentUserId: string | null;
  params: DashboardParams;
}) {
  // Convert empty array to undefined so buildRunListQuery skips the filter
  // and returns runs across all instruments (the unfiltered default).
  const instrumentIds =
    params.instrument_id.length > 0 ? params.instrument_id : undefined;

  // Start independent toolbar fetches immediately; only the run list needs the
  // viewer timezone for the default "today" lookback.
  const instrumentsPromise = getInstruments(true);
  const ranByUsersPromise = getRanByFilterOptions();
  const defaultDateFrom = startOfTodayISO(await getViewerTimeZone());

  const [instruments, ranByUsers, runResult] = await Promise.all([
    instrumentsPromise,
    ranByUsersPromise,
    buildRunListQuery({
      instrumentId: instrumentIds,
      search: params.search || undefined,
      dateFrom: params.date_from ?? defaultDateFrom,
      dateTo: params.date_to ?? undefined,
      page: params.page,
      perPage: params.per_page,
      includeDeleted: params.include_deleted,
      ranBy: params.ran_by ?? undefined,
      statuses: params.status.length > 0 ? params.status : undefined,
      sort: params.sort,
      order: params.order,
    }),
  ]);

  // Current user pinned as "You" at the top (if they've attributed anything),
  // then other attributors by display name, then the "Unattributed" sentinel —
  // matching the per-instrument page's dropdown.
  const meOption = currentUserId
    ? ranByUsers.find((u) => u.userId === currentUserId)
    : undefined;
  const ranByOptions = [
    ...(meOption ? [{ value: meOption.userId, label: "You" }] : []),
    ...ranByUsers
      .filter((u) => u.userId !== currentUserId)
      .map((u) => ({ value: u.userId, label: u.displayName })),
    { value: "unattributed", label: "Unattributed" },
  ];

  const hasFilters = hasActiveFilters(params);

  return (
    <RunSelectionProvider>
      <TablePendingProvider>
        <div className="flex flex-col gap-3">
          <RunsToolbar dateDefaultPreset="today" instruments={instruments} />
          <RunBulkActionBar />
          <TablePendingBoundary>
            <RunsTable
              data={runResult.data}
              hasFilters={hasFilters}
              ranByOptions={ranByOptions}
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

async function DashboardCommentPanels({
  currentUserId,
}: {
  currentUserId: string | null;
}) {
  const [all, mine] = await Promise.all([
    listCommentFeed({ count: false, perPage: RECENT_COMMENTS_LIMIT }),
    currentUserId
      ? listCommentFeed({
          count: false,
          perPage: RECENT_COMMENTS_LIMIT,
          ranBy: currentUserId,
        })
      : Promise.resolve(null),
  ]);

  return (
    <>
      <CommentPreviewPanel
        comments={all.data}
        emptyLabel="No comments yet."
        href="/comments"
        value="all"
      />
      <CommentPreviewPanel
        comments={mine?.data ?? []}
        emptyLabel={onRunsEmptyLabel("", true)}
        href={
          currentUserId
            ? `/comments?ran_by=${encodeURIComponent(currentUserId)}`
            : "/comments"
        }
        value="mine"
      />
    </>
  );
}
