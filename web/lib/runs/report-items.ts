import type { InstrumentType } from "@/lib/db/schema";

export const REPORT_ITEM_KINDS = ["image", "pdf", "spectrum", "video"] as const;

export type ReportItemKind = (typeof REPORT_ITEM_KINDS)[number];

// Slim projection: the report viewers seek by filename and fetch bytes per
// selection, so full file rows never reach the client.
export interface ReportItem {
  filename: string;
  id: number;
}

export interface ReportItemsPage {
  data: ReportItem[];
  pagination: {
    // Position of the requested `anchor` in the unfiltered ordering, or null
    // when it was not requested or no longer matches.
    anchor_index?: number | null;
    limit: number;
    offset: number;
    total: number;
  };
}

export interface SeekerActions {
  clearSearch: (anchorId?: number) => void;
  loadMore: () => void;
  loadPrevious: () => void;
  next: () => void;
  previous: () => void;
  selectId: (id: number) => void;
  setSearch: (value: string) => void;
}

export interface SeekerState {
  error: string | null;
  hasMore: boolean;
  hasPrevious: boolean;
  isLoading: boolean;
  items: ReportItem[];
  search: string;
  selectedIndex: number;
  selectedItem: ReportItem | null;
  total: number;
}

// What `SeekerToolbar` needs from whoever owns the list. `useReportItems`
// fetches pages; `AuntyWellsProvider` serves a list it already has in memory.
export interface SeekerSource {
  actions: SeekerActions;
  state: SeekerState;
}

// Items per window, both for the server render and each subsequent fetch.
export const REPORT_ITEMS_WINDOW = 50;

export const REPORT_ITEMS_MAX_LIMIT = 200;

// Every run-detail variant renders a "Report Data" section except the plate
// reader, which shows "Plate Maps". The loading skeleton has to match.
export function showsReportDataSection(instrumentType: InstrumentType) {
  return instrumentType !== "plate_reader";
}

const KIND_BY_INSTRUMENT: Partial<Record<InstrumentType, ReportItemKind>> = {
  gel_doc: "image",
  hina_microscope: "image",
  tape_station: "pdf",
  instant_raman: "spectrum",
  dishcam: "video",
};

export function reportItemKindForInstrument(
  instrumentType: InstrumentType
): ReportItemKind | null {
  return KIND_BY_INSTRUMENT[instrumentType] ?? null;
}

export function isReportItemKind(value: string): value is ReportItemKind {
  return (REPORT_ITEM_KINDS as readonly string[]).includes(value);
}

export function emptyReportItemsPage(): ReportItemsPage {
  return {
    data: [],
    pagination: { limit: REPORT_ITEMS_WINDOW, offset: 0, total: 0 },
  };
}

export function reportItemsUrl(
  instrumentId: string,
  runId: string,
  query: {
    anchor?: number;
    kind: ReportItemKind;
    limit: number;
    offset: number;
    search: string;
  }
): string {
  const params = new URLSearchParams({
    kind: query.kind,
    offset: String(query.offset),
    limit: String(query.limit),
  });
  if (query.search) {
    params.set("search", query.search);
  }
  if (query.anchor !== undefined) {
    params.set("anchor", String(query.anchor));
  }
  return `/api/v1/instruments/${encodeURIComponent(instrumentId)}/runs/${encodeURIComponent(runId)}/report-items?${params}`;
}
