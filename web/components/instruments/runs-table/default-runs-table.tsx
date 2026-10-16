import type { RunsTableProps } from ".";
import { RunRowsTable } from "./run-rows-table";

export function DefaultRunsTable(props: RunsTableProps) {
  return <RunRowsTable {...props} />;
}
