import { NotebookText, SearchX } from "lucide-react";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { SearchColumnHeader } from "@/components/dashboard/search-column-header";
import { EmptyState } from "@/components/empty-state";
import {
  FilterableColumnHeader,
  type FilterOption,
} from "@/components/instruments/runs-table/filterable-column-header";
import { RunsTableFooter } from "@/components/instruments/runs-table/runs-table-footer";
import { NotebookExternalLink } from "@/components/notebooks/notebook-external-link";
import { NotebookSortHeader } from "@/components/notebooks/notebook-sort-header";
import { RowControl, RowLink } from "@/components/row-link";
import { TruncatedTooltip } from "@/components/truncated-tooltip";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserAvatarLink } from "@/components/user-avatar";
import type { NotebookDto } from "@/lib/api/notebooks";
import { notebookPageHref } from "@/lib/notebooks/details";
import { CODE_BADGE_COLORS, TABLE_EDGE_PADDING } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

function NoValue({ label }: { label: string }) {
  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Which list a notebooks table shows:
 *
 * - `all`: the `/lab-notebooks` list, whose column headers sort it.
 * - `recent`: the notebooks on Home that got a run in the picked range, the
 *   ones that most recently got a run first. Its Name header searches them.
 * - `owned`: the notebooks a member owns, on their page. Every row has the
 *   same owner, so it leaves out the Owner column.
 *
 * `recent` and `owned` sit below a runs table, which owns the `sort`, `order`,
 * and `page` params that the sort headers write, so their headers don't sort.
 */
export type NotebooksTableVariant = "all" | "recent" | "owned";

/**
 * One row per notebook, whose name opens its page. `emptyMessage` is what to
 * say when there are no rows, which depends on the search.
 */
export function NotebooksTable({
  notebooks,
  totalCount,
  emptyMessage,
  filtered,
  ownerOptions,
  variant = "all",
}: {
  notebooks: NotebookDto[];
  totalCount: number;
  emptyMessage: string;
  // A search or filter narrowed the list, so the empty state shows a search
  // icon.
  filtered: boolean;
  // When given, the Owner column filters Home's list by `notebooks_owner`,
  // like the runs table's Ran By column.
  ownerOptions?: FilterOption[];
  variant?: NotebooksTableVariant;
}) {
  const sortable = variant === "all";
  const showOwner = variant !== "owned";

  if (notebooks.length === 0) {
    return (
      <EmptyState icon={filtered ? SearchX : NotebookText}>
        {emptyMessage}
      </EmptyState>
    );
  }

  return (
    <div className="isolate rounded-lg border bg-background dark:bg-muted">
      <Table className={TABLE_EDGE_PADDING}>
        <TableHeader>
          <TableRow>
            {sortable ? <NotebookSortHeader field="name" label="Name" /> : null}
            {variant === "recent" ? (
              <TableHead>
                <SearchColumnHeader
                  inputLabel="Search lab notebooks"
                  label="Name"
                  param="notebooks_q"
                  placeholder="Search by name or paste a link…"
                />
              </TableHead>
            ) : null}
            {variant === "owned" ? <TableHead>Name</TableHead> : null}
            {showOwner ? (
              <TableHead>
                {ownerOptions ? (
                  <FilterableColumnHeader
                    label="Owner"
                    options={ownerOptions}
                    pageKey="notebooks_page"
                    paramKey="notebooks_owner"
                    paramsSource="dashboard"
                  />
                ) : (
                  "Owner"
                )}
              </TableHead>
            ) : null}
            {sortable ? (
              <NotebookSortHeader align="end" field="run_count" label="Runs" />
            ) : (
              <TableHead className="text-right">Runs</TableHead>
            )}
            <TableHead className="text-right">Instruments</TableHead>
            {sortable ? (
              <NotebookSortHeader
                align="end"
                field="last_run"
                label="Last run"
              />
            ) : (
              <TableHead className="text-right">Last run</TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {notebooks.map((notebook) => {
            const deleted = notebook.deletedAt !== null;
            return (
              <TableRow className="relative text-sm" key={notebook.id}>
                <TableCell>
                  {/* `h-7` matches the runs table's Ran By cell, so every row is
                      as tall as a run row, with or without an owner. */}
                  <div className="flex h-7 max-w-96 items-center gap-1">
                    <TruncatedTooltip text={notebook.name}>
                      <RowLink
                        className={cn(
                          "min-w-0 truncate font-medium",
                          deleted && "text-muted-foreground"
                        )}
                        href={notebookPageHref(notebook.id)}
                      >
                        {notebook.name}
                      </RowLink>
                    </TruncatedTooltip>
                    <RowControl>
                      <NotebookExternalLink
                        name={notebook.name}
                        url={notebook.url}
                      />
                    </RowControl>
                    {deleted ? (
                      <Badge
                        className={cn("ml-1 font-normal", CODE_BADGE_COLORS)}
                        variant="outline"
                      >
                        Deleted
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                {showOwner ? (
                  <TableCell>
                    {notebook.owner ? (
                      <RowControl>
                        <UserAvatarLink user={notebook.owner}>
                          <span className="max-w-40 truncate">
                            {notebook.owner.displayName}
                          </span>
                        </UserAvatarLink>
                      </RowControl>
                    ) : (
                      <NoValue label="No owner" />
                    )}
                  </TableCell>
                ) : null}
                <TableCell className="text-right tabular-nums">
                  {notebook.runCount.toLocaleString("en-US")}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {notebook.instrumentCount.toLocaleString("en-US")}
                </TableCell>
                <TableCell className="text-right">
                  {notebook.lastRunAt ? (
                    <RelativeTime date={notebook.lastRunAt.toISOString()} />
                  ) : (
                    <NoValue label="No runs yet" />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <RunsTableFooter shownCount={notebooks.length} totalCount={totalCount} />
    </div>
  );
}

/**
 * Placeholder for `NotebooksTable`. Pass the table's `variant` so the columns
 * match, and `rows` for a shorter page.
 */
export function NotebooksTableSkeleton({
  rows = 8,
  variant = "all",
}: {
  rows?: number;
  variant?: NotebooksTableVariant;
}) {
  const showOwner = variant !== "owned";
  return (
    <div
      aria-busy="true"
      aria-label="Loading lab notebooks"
      className="rounded-lg border bg-background dark:bg-muted"
      role="status"
    >
      <Table className={TABLE_EDGE_PADDING}>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            {showOwner ? <TableHead>Owner</TableHead> : null}
            <TableHead className="text-right">Runs</TableHead>
            <TableHead className="text-right">Instruments</TableHead>
            <TableHead className="text-right">Last run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                {/* As tall as a loaded row's name cell. */}
                <div className="flex h-7 items-center">
                  <Skeleton className="h-4 w-48" />
                </div>
              </TableCell>
              {showOwner ? (
                <TableCell>
                  <Skeleton className="h-6 w-28" />
                </TableCell>
              ) : null}
              <TableCell>
                <Skeleton className="ml-auto h-4 w-8" />
              </TableCell>
              <TableCell>
                <Skeleton className="ml-auto h-4 w-8" />
              </TableCell>
              <TableCell>
                <Skeleton className="ml-auto h-4 w-20" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
