import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { NewNotebookDialog } from "@/components/notebooks/new-notebook-dialog";
import {
  NotebooksTable,
  NotebooksTableSkeleton,
} from "@/components/notebooks/notebooks-table";
import { NotebooksToolbar } from "@/components/notebooks/notebooks-toolbar";
import { PaginationNav } from "@/components/pagination-nav";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
import { listNotebooks } from "@/lib/api/notebooks";
import { auth } from "@/lib/auth";
import { notebooksEmptyMessage } from "@/lib/notebooks/details";
import { notebooksIndexParamsCache } from "@/lib/search-params";

export const metadata: Metadata = {
  title: "Notebooks",
  openGraph: { title: "Notebooks" },
  twitter: { title: "Notebooks" },
};

const NOTEBOOKS_PER_PAGE = 50;

type NotebooksParams = Awaited<
  ReturnType<typeof notebooksIndexParamsCache.parse>
>;

export default async function NotebooksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session) {
    return <SignInRequired>Sign in to browse lab notebooks.</SignInRequired>;
  }

  const params = notebooksIndexParamsCache.parse(await searchParams);

  // The heading and toolbar paint at once; the table streams in.
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6 2xl:w-6xl">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-semibold text-2xl tracking-tight">Notebooks</h1>
        <NewNotebookDialog />
      </div>
      <TablePendingProvider>
        <div className="flex flex-col gap-3">
          <NotebooksToolbar />
          <Suspense fallback={<NotebooksTableSkeleton />}>
            <NotebooksListSection params={params} />
          </Suspense>
        </div>
      </TablePendingProvider>
    </div>
  );
}

async function NotebooksListSection({ params }: { params: NotebooksParams }) {
  const query = params.q.trim();
  const result = await listNotebooks({
    query: query || undefined,
    includeDeleted: params.include_deleted,
    sort: params.sort,
    order: params.order ?? undefined,
    page: params.page,
    perPage: NOTEBOOKS_PER_PAGE,
  });

  return (
    <>
      <TablePendingBoundary>
        <NotebooksTable
          emptyMessage={notebooksEmptyMessage(query)}
          filtered={query !== ""}
          notebooks={result.notebooks}
          totalCount={result.total}
        />
      </TablePendingBoundary>
      <PaginationNav
        page={result.page}
        pageParam="page"
        totalPages={Math.ceil(result.total / result.perPage)}
      />
    </>
  );
}
