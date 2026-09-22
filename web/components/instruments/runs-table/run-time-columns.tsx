import { RelativeTime } from "@/components/dashboard/relative-time";
import { TableCell } from "@/components/ui/table";
import type { RunListRow } from "@/lib/api/instrument-runs";

import { SortableColumnHeader } from "./sortable-column-header";

export function RunTimeHeads() {
  return (
    <>
      <SortableColumnHeader field="acquired_at" label="Run Started" />
      <SortableColumnHeader field="updated_at" label="Last Updated" />
    </>
  );
}

export function RunTimeCells({ row }: { row: RunListRow }) {
  return (
    <>
      <TableCell className="text-right">
        <RelativeTime
          date={new Date(row.acquired_at ?? row.created_at).toISOString()}
        />
      </TableCell>
      <TableCell className="text-right">
        <RelativeTime date={new Date(row.updated_at).toISOString()} />
      </TableCell>
    </>
  );
}
