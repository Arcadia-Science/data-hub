import { describe, expect, it } from "vitest";
import {
  clearedInstrumentFilters,
  hasActiveFilters,
  hasActiveInstrumentFilters,
  INSTRUMENT_NULLABLE_FILTER_KEYS,
  instrumentDetailSearchParams,
} from "@/lib/search-params";

const noDashboardFilters = {
  search: "",
  instrument_id: [],
  date_from: null,
  date_to: null,
  include_deleted: false,
  status: [],
  ran_by: null,
};

describe("hasActiveFilters", () => {
  it("is false when nothing is set", () => {
    expect(hasActiveFilters(noDashboardFilters)).toBe(false);
  });

  it("counts each filter, including a date range", () => {
    expect(hasActiveFilters({ ...noDashboardFilters, search: "a" })).toBe(true);
    expect(
      hasActiveFilters({ ...noDashboardFilters, instrument_id: ["gel-1"] })
    ).toBe(true);
    expect(
      hasActiveFilters({ ...noDashboardFilters, include_deleted: true })
    ).toBe(true);
    expect(
      hasActiveFilters({ ...noDashboardFilters, status: ["failed"] })
    ).toBe(true);
    expect(hasActiveFilters({ ...noDashboardFilters, ran_by: "u1" })).toBe(
      true
    );
    expect(
      hasActiveFilters({ ...noDashboardFilters, date_from: "2026-10-01" })
    ).toBe(true);
    expect(
      hasActiveFilters({ ...noDashboardFilters, date_to: "2026-10-02" })
    ).toBe(true);
  });
});

function noInstrumentFilters() {
  return {
    search: "",
    include_deleted: false,
    status: [] as never[],
    ...(Object.fromEntries(
      INSTRUMENT_NULLABLE_FILTER_KEYS.map((key) => [key, null])
    ) as Record<(typeof INSTRUMENT_NULLABLE_FILTER_KEYS)[number], null>),
  };
}

describe("INSTRUMENT_NULLABLE_FILTER_KEYS", () => {
  // Keys of `instrumentDetailSearchParams` that are not nullable filters. A new
  // filter added there must also be added to the list, or this test fails.
  const NOT_NULLABLE_FILTERS = new Set([
    "search",
    "include_deleted",
    "status",
    "page",
    "per_page",
    "sort",
    "order",
  ]);

  it("lists every nullable filter the instrument page can set", () => {
    const filters = Object.keys(instrumentDetailSearchParams)
      .filter((key) => !NOT_NULLABLE_FILTERS.has(key))
      .sort();
    expect([...INSTRUMENT_NULLABLE_FILTER_KEYS].sort()).toEqual(filters);
  });
});

describe("hasActiveInstrumentFilters", () => {
  it("is false when nothing is set", () => {
    expect(hasActiveInstrumentFilters(noInstrumentFilters())).toBe(false);
  });

  it("treats every nullable filter as active, including Ran By", () => {
    for (const key of INSTRUMENT_NULLABLE_FILTER_KEYS) {
      expect(
        hasActiveInstrumentFilters({ ...noInstrumentFilters(), [key]: "x" })
      ).toBe(true);
    }
    expect(INSTRUMENT_NULLABLE_FILTER_KEYS).toContain("ran_by");
  });

  it("counts search, deleted runs, and status", () => {
    expect(
      hasActiveInstrumentFilters({ ...noInstrumentFilters(), search: "a" })
    ).toBe(true);
    expect(
      hasActiveInstrumentFilters({
        ...noInstrumentFilters(),
        include_deleted: true,
      })
    ).toBe(true);
    expect(
      hasActiveInstrumentFilters({
        ...noInstrumentFilters(),
        status: ["failed"],
      })
    ).toBe(true);
  });
});

describe("clearedInstrumentFilters", () => {
  it("resets every filter and goes back to page 1", () => {
    const cleared = clearedInstrumentFilters();
    expect(cleared.page).toBe(1);
    expect(cleared.search).toBe("");
    expect(cleared.ran_by).toBeNull();
    expect(hasActiveInstrumentFilters(cleared)).toBe(false);
  });
});
