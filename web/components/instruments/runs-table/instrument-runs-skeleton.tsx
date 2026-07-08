import { AcquiredColumnHeader } from "@/components/instruments/runs-table/acquired-column-header";
import { RawFileColumnHeader } from "@/components/instruments/runs-table/raw-file-column-header";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function RunsTableFooterSkeleton() {
  return (
    <div className="flex items-center justify-between border-t px-4 py-3">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-3 w-56" />
    </div>
  );
}

function InstrumentRunsToolbarSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Skeleton className="h-9 w-64" />
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
    </div>
  );
}

// Per-instrument run tables omit the Instrument column present on the dashboard
// variant; footer + row layout mirror `DefaultRunsTable` inside
// `InstrumentRunsTableShell`.
export function InstrumentRunsTableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="rounded-lg border bg-background dark:bg-muted">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10" />
            <TableHead>Run ID</TableHead>
            <TableHead>
              <RawFileColumnHeader label="Files" />
            </TableHead>
            <TableHead className="text-right">
              <RawFileColumnHeader label="Size" />
            </TableHead>
            <TableHead>Ran By</TableHead>
            <TableHead className="text-right">
              <AcquiredColumnHeader />
            </TableHead>
            <TableHead className="w-[108px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRow key={i}>
              <TableCell className="py-2.75">
                <Skeleton className="size-5" />
              </TableCell>
              <TableCell className="py-2.75">
                <div className="flex items-center gap-2.5">
                  <Skeleton className="size-5 rounded-full" />
                  <Skeleton className="h-5 w-28" />
                </div>
              </TableCell>
              <TableCell className="py-2.75">
                <Skeleton className="h-5 w-8" />
              </TableCell>
              <TableCell className="py-2.75 text-right">
                <Skeleton className="ml-auto h-5 w-16" />
              </TableCell>
              <TableCell className="py-2.75">
                <Skeleton className="h-5 w-16" />
              </TableCell>
              <TableCell className="py-2.75 text-right">
                <Skeleton className="ml-auto h-5 w-20" />
              </TableCell>
              <TableCell className="py-2.75">
                <Skeleton className="ml-auto h-5 w-7" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <RunsTableFooterSkeleton />
    </div>
  );
}

export function InstrumentRunsSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading runs"
      className="flex flex-col gap-3"
      role="status"
    >
      <InstrumentRunsToolbarSkeleton />
      <InstrumentRunsTableSkeleton />
    </div>
  );
}
