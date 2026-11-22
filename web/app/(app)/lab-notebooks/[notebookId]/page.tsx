import { notFound } from "next/navigation";
import type { Metadata } from "next/types";
import { cache, Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import {
  DashboardRunsSkeleton,
  RunsTable,
} from "@/components/dashboard/runs-table";
import { RunsToolbar } from "@/components/dashboard/runs-toolbar";
import { RunBulkActionBar } from "@/components/instruments/runs-table/run-bulk-action-bar";
import { RunSelectionProvider } from "@/components/instruments/runs-table/run-selection-provider";
import { NotebookHeader } from "@/components/notebooks/notebook-header";
import { PaginationNav } from "@/components/pagination-nav";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
import { getInstruments } from "@/lib/api/dashboard";
import {
  buildRunListQuery,
  getRanByFilterOptions,
} from "@/lib/api/instrument-runs";
import { getNotebook, type NotebookDto } from "@/lib/api/notebooks";
import { auth } from "@/lib/auth";
import {
  ALL_TIME_DATE_FROM,
  dashboardParamsCache,
  hasActiveFilters,
} from "@/lib/search-params";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

type RunParams = Awaited<ReturnType<typeof dashboardParamsCache.parse>>;

interface Props {
  params: Promise<{ notebookId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// The metadata and the page both read the notebook; this makes it one query.
// An ID that isn't a UUID matches no notebook.
const loadNotebook = cache(getNotebook);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { notebookId } = await params;
  const notebook = await loadNotebook(notebookId);
  if (!notebook) {
    return { title: "Lab notebook not found" };
  }
  // Link previews in Slack or Notion show the name. The description stays
  // generic: the notebook's own description and its runs need a sign-in.
  const title = notebook.name;
  const description = "Runs in this lab notebook, across instruments.";
  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary", title, description },
  };
}

export default async function NotebookPage({ params, searchParams }: Props) {
  const session = await auth();
  const { notebookId } = await params;
  // generateMetadata above still runs without a session, so a pasted link
  // unfurls with the notebook's name. A signed-out visitor gets a sign-in
  // prompt that returns here.
  if (!session) {
    return <SignInRequired>Sign in to view this lab notebook.</SignInRequired>;
  }

  // Before anything streams, so an unknown notebook is a real 404.
  const notebook = await loadNotebook(notebookId);
  if (!notebook) {
    notFound();
  }

  const [runParams, timeZone] = await Promise.all([
    searchParams.then((value) => dashboardParamsCache.parse(value)),
    getViewerTimeZone(),
  ]);

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-8 px-6 pt-3.5 pb-6 2xl:w-6xl">
      {/* `pt-3.5` centers the breadcrumbs on the sidebar's "Navigation" label. */}
      <NotebookHeader
        notebook={notebook}
        timeZone={timeZone}
        viewerId={session.user.id}
      />
      <section className="flex scroll-mt-6 flex-col gap-3" id="runs">
        {/* One pending state for the toolbar, the column filters, and the
            pages, so each dims the table while it loads. */}
        <TablePendingProvider>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium text-lg tracking-tight">
              Instrument runs
            </h2>
            <RunsToolbar />
          </div>
          <Suspense fallback={<DashboardRunsSkeleton />}>
            <NotebookRunsSection
              currentUserId={session.user.id}
              notebook={notebook}
              params={runParams}
            />
          </Suspense>
        </TablePendingProvider>
      </section>
    </div>
  );
}

/**
 * The notebook's runs from every instrument, with the Home page's search,
 * instrument, date, and status filters. The page fixes the notebook, so the
 * URL's `lab_notebook_id` and `has_lab_notebook` are ignored, and it lists all time
 * unless a date range is picked.
 */
async function NotebookRunsSection({
  currentUserId,
  notebook,
  params,
}: {
  currentUserId: string;
  notebook: NotebookDto;
  params: RunParams;
}) {
  const instrumentIds =
    params.instrument_id.length > 0 ? params.instrument_id : undefined;

  const [instruments, ranByUsers, runResult] = await Promise.all([
    getInstruments(true),
    getRanByFilterOptions(),
    buildRunListQuery({
      notebookId: notebook.id,
      instrumentId: instrumentIds,
      search: params.search || undefined,
      // A link from Home can carry its "all time" marker.
      dateFrom:
        params.date_from === ALL_TIME_DATE_FROM
          ? undefined
          : (params.date_from ?? undefined),
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

  // The viewer pinned as "You" at the top (if they've attributed anything),
  // then other attributors by display name, then "Unattributed", as on Home.
  const meOption = ranByUsers.find((u) => u.userId === currentUserId);
  const ranByOptions = [
    ...(meOption ? [{ value: meOption.userId, label: "You" }] : []),
    ...ranByUsers
      .filter((u) => u.userId !== currentUserId)
      .map((u) => ({ value: u.userId, label: u.displayName })),
    { value: "unattributed", label: "Unattributed" },
  ];

  const hasFilters = hasActiveFilters({
    ...params,
    has_lab_notebook: null,
    lab_notebook_id: null,
  });

  return (
    <RunSelectionProvider>
      <div className="flex flex-col gap-3">
        <RunBulkActionBar
          notebook={{
            id: notebook.id,
            name: notebook.name,
            deleted: notebook.deletedAt !== null,
          }}
        />
        <TablePendingBoundary>
          <RunsTable
            data={runResult.data}
            emptyLabel="No runs in this lab notebook yet. Add runs from a run’s page, or select runs in any runs table and choose Add to lab notebook."
            hasFilters={hasFilters}
            instruments={instruments}
            notebookId={notebook.id}
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
    </RunSelectionProvider>
  );
}
