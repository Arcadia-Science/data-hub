import type { InstrumentType } from "@/lib/db/schema";
import { SearchX } from "lucide-react";

import { DefaultRunsTable } from "./default-runs-table";
import { PlateReaderRunsTable } from "./plate-reader-runs-table";

export type RunRow = {
  id: string;
  instrument_id: string;
  instrument_display_name: string;
  run_id: string;
  source: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  file_count: number;
  files_completed: number;
  files_failed: number;
  files_pending_upload: number;
};

export type RunsTableProps = {
  data: RunRow[];
  instrumentId: string;
};

export function InstrumentRunsTable({
  data,
  instrumentId,
  instrumentType,
  hasFilters,
}: {
  data: RunRow[];
  instrumentId: string;
  instrumentType: InstrumentType;
  hasFilters: boolean;
}) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-16">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {hasFilters
            ? "No runs match your filters."
            : "No instrument runs yet."}
        </p>
      </div>
    );
  }

  const tableProps = { data, instrumentId };

  switch (instrumentType) {
    case "plate_reader":
      return <PlateReaderRunsTable {...tableProps} />;
    default:
      return <DefaultRunsTable {...tableProps} />;
  }
}
