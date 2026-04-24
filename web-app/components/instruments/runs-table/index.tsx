import type {
  GelDocFilterOptions,
  HinaFilterOptions,
  PlateReaderFilterOptions,
  QpcrFilterOptions,
  RunListRow,
} from "@/lib/api/instrument-runs";
import type { InstrumentType } from "@/lib/db/schema";
import { SearchX } from "lucide-react";

import { DefaultRunsTable } from "./default-runs-table";
import { GelDocRunsTable } from "./gel-doc-runs-table";
import { HinaRunsTable } from "./hina-runs-table";
import { PlateReaderRunsTable } from "./plate-reader-runs-table";
import { QpcrRunsTable } from "./qpcr-runs-table";
import { RunsTableFooter } from "./runs-table-footer";

// Re-export under the historical name so imports like
// `import type { RunRow } from "@/components/instruments/runs-table"`
// keep working. The type itself is now derived server-side.
export type RunRow = RunListRow;

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
  hinaFilterOptions,
  ranByOptions,
  totalCount,
  pendingUploadCount,
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
  hinaFilterOptions?: HinaFilterOptions;
  ranByOptions: RanByOption[];
  totalCount: number;
  pendingUploadCount: number;
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
    case "hina_microscope":
      table = (
        <HinaRunsTable
          data={data}
          instrumentId={instrumentId}
          filterOptions={hinaFilterOptions!}
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
        pendingUploadCount={pendingUploadCount}
        unattributedCount={unattributedCount}
        ranByYouCount={ranByYouCount}
      />
    </div>
  );
}
