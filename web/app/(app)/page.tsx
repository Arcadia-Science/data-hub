import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { CommentDateFilter } from "@/components/comments/comment-date-filter";
import {
  CommentListSkeleton,
  CommentPreview,
} from "@/components/comments/comment-list";
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
  DashboardInstrumentsTableSkeleton,
  InstrumentsTable,
} from "@/components/instruments/instruments-table";
import { RunBulkActionBar } from "@/components/instruments/runs-table/run-bulk-action-bar";
import { RunSelectionProvider } from "@/components/instruments/runs-table/run-selection-provider";
import { NotebookListFilters } from "@/components/notebooks/notebook-list-filters";
import {
  NotebooksTable,
  NotebooksTableSkeleton,
} from "@/components/notebooks/notebooks-table";
import { PaginationNav } from "@/components/pagination-nav";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
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
import {
  getNotebookFilterOptions,
  getNotebookOwnerOptions,
  listNotebooks,
} from "@/lib/api/notebooks";
import { listCommentFeed } from "@/lib/api/run-comments";
import {
  parseHasNotebookParam,
  parseNotebookIdParam,
} from "@/lib/api/validators";
import { auth } from "@/lib/auth";
import { startOfTodayISO } from "@/lib/date";
import {
  ALL_TIME_DATE_FROM,
  dashboardParamsCache,
  hasActiveFilters,
  NOTEBOOK_OWNER_NONE,
} from "@/lib/search-params";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

type DashboardParams = Awaited<ReturnType<typeof dashboardParamsCache.parse>>;

const RECENT_INSTRUMENTS_LIMIT = 3;
const NOTEBOOKS_PER_PAGE = 5;
const RECENT_COMMENTS_LIMIT = 4;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  // Render the page metadata (title) for unauthenticated visitors so links
  // shared into Notion / Slack still unfurl with a useful title; show a
  // sign-in CTA in the body instead of leaking data. Signing in brings real
  // users back to this address, query included.
  if (!session) {
    return <SignInRequired>Sign in to view your dashboard.</SignInRequired>;
  }

  const params = dashboardParamsCache.parse(await searchParams);
  const currentUserId = session.user?.id ?? null;

  // Each section fetches its own data behind a Suspense boundary so the static
  // shell (headings) paints immediately and the three data blocks stream in
  // independently — a slow runs query no longer holds up the stats cards.
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 2xl:w-6xl">
      <h1 className="sr-only">Dashboard</h1>
      <Suspense fallback={<StatCardsSkeleton />}>
        <DashboardStatsSection />
      </Suspense>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-lg tracking-tight">Instruments</h2>
        <Suspense
          fallback={
            <DashboardInstrumentsTableSkeleton footerLabel="View all instruments" />
          }
        >
          <DashboardInstrumentsSection />
        </Suspense>
      </section>

      <section className="flex scroll-mt-6 flex-col gap-3" id="runs">
        {/* One pending state for the toolbar, the column filters, and the
            pages, so each dims the table while it loads. */}
        <TablePendingProvider>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium text-lg tracking-tight">
              Instrument runs
            </h2>
            <RunsToolbar dateDefaultPreset="today" />
          </div>
          <Suspense fallback={<DashboardRunsSkeleton />}>
            <DashboardRunsSection
              currentUserId={currentUserId}
              params={params}
            />
          </Suspense>
        </TablePendingProvider>
      </section>

      <section className="flex scroll-mt-6 flex-col gap-3" id="lab-notebooks">
        {/* One pending state for the date range, the Owner filter, and the
            pages, so each dims the table while it loads, and paging the
            notebooks doesn't dim the runs table. */}
        <TablePendingProvider>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-pretty font-medium text-lg tracking-tight">
              Lab notebooks
            </h2>
            <NotebookListFilters />
          </div>
          <Suspense
            fallback={
              <NotebooksTableSkeleton
                rows={NOTEBOOKS_PER_PAGE}
                variant="recent"
              />
            }
          >
            <DashboardNotebooksSection
              currentUserId={currentUserId}
              dateFrom={params.notebooks_from}
              dateTo={params.notebooks_to}
              owner={params.notebooks_owner}
              page={params.notebooks_page}
              query={params.notebooks_q}
            />
          </Suspense>
        </TablePendingProvider>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-pretty font-medium text-lg tracking-tight">
            Comments
          </h2>
          <CommentDateFilter />
        </div>
        <Suspense
          fallback={<CommentListSkeleton />}
          key={`${params.comments_from ?? ""}:${params.comments_to ?? ""}`}
        >
          <DashboardCommentPanels
            dateFrom={params.comments_from}
            dateTo={params.comments_to}
          />
        </Suspense>
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

async function DashboardNotebooksSection({
  currentUserId,
  dateFrom,
  dateTo,
  owner,
  page,
  query,
}: {
  currentUserId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  owner: string | null;
  page: number;
  query: string;
}) {
  let ownerFilter: { hasOwner?: boolean; ownerId?: string } = {};
  if (owner === NOTEBOOK_OWNER_NONE) {
    ownerFilter = { hasOwner: false };
  } else if (owner) {
    ownerFilter = { ownerId: owner };
  }

  // Like the runs list, today's unless the URL picks a range or all time.
  const runFrom =
    dateFrom === ALL_TIME_DATE_FROM
      ? undefined
      : (dateFrom ?? startOfTodayISO(await getViewerTimeZone()));

  // Everyone's live lab notebooks that got a run in the range, the ones that
  // most recently got a run first.
  const [result, owners] = await Promise.all([
    listNotebooks({
      ...ownerFilter,
      query: query.trim() || undefined,
      runFrom,
      runTo: dateTo ?? undefined,
      page,
      perPage: NOTEBOOKS_PER_PAGE,
      sort: "last_run",
    }),
    getNotebookOwnerOptions(),
  ]);

  // The viewer pinned as "You" at the top (if they own any), then other owners
  // by display name, then "No owner", like the runs table's Ran By filter.
  const meOption = currentUserId
    ? owners.find((o) => o.userId === currentUserId)
    : undefined;
  const ownerOptions = [
    ...(meOption ? [{ value: meOption.userId, label: "You" }] : []),
    ...owners
      .filter((o) => o.userId !== currentUserId)
      .map((o) => ({ value: o.userId, label: o.displayName })),
    { value: NOTEBOOK_OWNER_NONE, label: "No owner" },
  ];
  const filtered =
    query.trim() !== "" ||
    owner !== null ||
    dateFrom !== null ||
    dateTo !== null;

  return (
    <div className="flex flex-col gap-3">
      <TablePendingBoundary>
        <NotebooksTable
          emptyMessage={
            filtered
              ? "No lab notebooks match these filters."
              : "No lab notebooks got a run today."
          }
          filtered={filtered}
          notebooks={result.notebooks}
          ownerOptions={ownerOptions}
          totalCount={result.total}
          variant="recent"
        />
      </TablePendingBoundary>
      <PaginationNav
        className="pb-0"
        page={result.page}
        pageParam="notebooks_page"
        totalPages={Math.ceil(result.total / result.perPage)}
      />
    </div>
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
  const notebookOptionsPromise = getNotebookFilterOptions();
  const defaultDateFrom = startOfTodayISO(await getViewerTimeZone());

  const [instruments, ranByUsers, notebookOptions, runResult] =
    await Promise.all([
      instrumentsPromise,
      ranByUsersPromise,
      notebookOptionsPromise,
      buildRunListQuery({
        instrumentId: instrumentIds,
        search: params.search || undefined,
        dateFrom:
          params.date_from === ALL_TIME_DATE_FROM
            ? undefined
            : (params.date_from ?? defaultDateFrom),
        dateTo: params.date_to ?? undefined,
        page: params.page,
        perPage: params.per_page,
        includeDeleted: params.include_deleted,
        ranBy: params.ran_by ?? undefined,
        hasNotebook: parseHasNotebookParam(params.has_lab_notebook),
        ...parseNotebookIdParam(params.lab_notebook_id),
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
      <div className="flex flex-col gap-3">
        <RunBulkActionBar />
        <TablePendingBoundary>
          <RunsTable
            data={runResult.data}
            hasFilters={hasFilters}
            instruments={instruments}
            notebookOptions={notebookOptions}
            ranByOptions={ranByOptions}
            totalCount={runResult.pagination.total}
          />
        </TablePendingBoundary>
        <PaginationNav
          className="pb-0"
          page={runResult.pagination.page}
          pageParam="page"
          totalPages={runResult.pagination.total_pages}
        />
      </div>
    </RunSelectionProvider>
  );
}

async function DashboardCommentPanels({
  dateFrom,
  dateTo,
}: {
  dateFrom: string | null;
  dateTo: string | null;
}) {
  const timeZone = await getViewerTimeZone();
  const comments = await listCommentFeed({
    count: false,
    dateFrom: dateFrom ?? startOfTodayISO(timeZone),
    dateTo: dateTo ?? undefined,
    perPage: RECENT_COMMENTS_LIMIT,
  });

  return (
    <CommentPreview
      comments={comments.data}
      emptyLabel="No comments yet."
      href="/comments"
      timeZone={timeZone}
    />
  );
}
