import type {
  GelDocFilterOptions,
  PlateReaderFilterOptions,
  QpcrFilterOptions,
  RunAttribution,
} from "@/lib/api/instrument-runs";
import type { InstrumentType } from "@/lib/db/schema";
import { SearchX } from "lucide-react";

import { DefaultRunsTable } from "./default-runs-table";
import { GelDocRunsTable } from "./gel-doc-runs-table";
import { PlateReaderRunsTable } from "./plate-reader-runs-table";
import { QpcrRunsTable } from "./qpcr-runs-table";
import { RunsTableFooter } from "./runs-table-footer";

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
  total_size_bytes: number;
  error_messages: string[];
  attributions: RunAttribution[];
};

export type RanByOption = { value: string; label: string };

export type RunsTableProps = {
  data: RunRow[];
  instrumentId: string;
  ranByOptions: RanByOption[];
};

export function InstrumentRunsTable({
  data,
  instrumentId,
  instrumentType,
  hasFilters,
  filterOptions,
  gelDocFilterOptions,
  qpcrFilterOptions,
  ranByOptions,
  totalCount,
  unattributedCount,
  ranByYouCount,
}: {
  data: RunRow[];
  instrumentId: string;
  instrumentType: InstrumentType;
  hasFilters: boolean;
  filterOptions?: PlateReaderFilterOptions;
  gelDocFilterOptions?: GelDocFilterOptions;
  qpcrFilterOptions?: QpcrFilterOptions;
  ranByOptions: RanByOption[];
  totalCount: number;
  unattributedCount: number;
  ranByYouCount: number;
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

  let table;
  switch (instrumentType) {
    case "plate_reader":
      table = (
        <PlateReaderRunsTable
          data={data}
          instrumentId={instrumentId}
          filterOptions={filterOptions!}
          ranByOptions={ranByOptions}
        />
      );
      break;
    case "gel_doc":
      table = (
        <GelDocRunsTable
          data={data}
          instrumentId={instrumentId}
          filterOptions={gelDocFilterOptions!}
          ranByOptions={ranByOptions}
        />
      );
      break;
    case "qpcr":
      table = (
        <QpcrRunsTable
          data={data}
          instrumentId={instrumentId}
          filterOptions={qpcrFilterOptions!}
          ranByOptions={ranByOptions}
        />
      );
      break;
    default:
      table = (
        <DefaultRunsTable
          data={data}
          instrumentId={instrumentId}
          ranByOptions={ranByOptions}
        />
      );
  }

  return (
    <div className="rounded-lg border">
      {table}
      <RunsTableFooter
        shownCount={data.length}
        totalCount={totalCount}
        unattributedCount={unattributedCount}
        ranByYouCount={ranByYouCount}
      />
    </div>
  );
}
