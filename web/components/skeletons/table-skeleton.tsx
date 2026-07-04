import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Generic bordered-table placeholder for list/settings pages that don't have a
// bespoke skeleton (the runs table ships its own `RunsTableSkeleton`). Mirrors
// the real `rounded-lg border` + `<Table>` wrapper so streamed content swaps in
// without shifting layout.
export function TableSkeleton({
  columns = 5,
  rows = 5,
  headers,
  ariaLabel = "Loading table",
}: {
  columns?: number;
  rows?: number;
  // Real header labels keep the column widths honest while the body loads.
  headers?: string[];
  ariaLabel?: string;
}) {
  const columnCount = headers?.length ?? columns;
  return (
    <div
      aria-busy="true"
      aria-label={ariaLabel}
      className="rounded-lg border bg-background dark:bg-muted"
      role="status"
    >
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: columnCount }).map((_, i) => (
              <TableHead key={i}>{headers?.[i]}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, r) => (
            <TableRow key={r}>
              {Array.from({ length: columnCount }).map((_, c) => (
                <TableCell key={c}>
                  <Skeleton className="h-4 w-24" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
