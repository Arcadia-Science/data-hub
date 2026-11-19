import { NotebookText, SearchX } from "lucide-react";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { EmptyState } from "@/components/empty-state";
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
 * The `/notebooks` table: one row per notebook, whose name opens its page.
 * `emptyMessage` is what to say when there are no rows, which depends on the
 * search.
 */
export function NotebooksTable({
  notebooks,
  totalCount,
  emptyMessage,
  filtered,
}: {
  notebooks: NotebookDto[];
  totalCount: number;
  emptyMessage: string;
  // A search narrowed the list, so the empty state shows a search icon.
  filtered: boolean;
}) {
  if (notebooks.length === 0) {
    return (
      <EmptyState icon={filtered ? SearchX : NotebookText}>
        {emptyMessage}
      </EmptyState>
    );
  }

  return (
    <div className="isolate rounded-lg border bg-background dark:bg-muted">
      <Table>
        <TableHeader>
          <TableRow>
            <NotebookSortHeader field="name" label="Name" />
            <TableHead>Owner</TableHead>
            <NotebookSortHeader align="end" field="run_count" label="Runs" />
            <TableHead className="text-right">Instruments</TableHead>
            <NotebookSortHeader align="end" field="last_run" label="Last run" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {notebooks.map((notebook) => {
            const deleted = notebook.deletedAt !== null;
            return (
              <TableRow className="relative text-sm" key={notebook.id}>
                <TableCell>
                  <div className="flex max-w-96 items-center gap-1">
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
                      <Badge className="ml-1 font-normal" variant="outline">
                        Deleted
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
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

export function NotebooksTableSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading notebooks"
      className="rounded-lg border bg-background dark:bg-muted"
      role="status"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead className="text-right">Runs</TableHead>
            <TableHead className="text-right">Instruments</TableHead>
            <TableHead className="text-right">Last run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 8 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-48" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-6 w-28" />
              </TableCell>
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
