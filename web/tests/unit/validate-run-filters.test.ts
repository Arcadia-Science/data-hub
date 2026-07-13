import { beforeEach, describe, expect, it, vi } from "vitest";

// Pure-logic coverage for the metadata-filter validator that scopes
// `search_runs` to a single instrument. Both data-access dependencies are
// mocked so the test stays a fast unit test with no DB.

const { getInstrumentById, getInstrumentFilterOptions } = vi.hoisted(() => ({
  getInstrumentById: vi.fn(),
  getInstrumentFilterOptions: vi.fn(),
}));

vi.mock("@/lib/api/instruments", () => ({ getInstrumentById }));
vi.mock("@/lib/api/instrument-runs", () => ({ getInstrumentFilterOptions }));

import { validateSearchRunsMetadataFilters } from "@/lib/mcp/validate-run-filters";

const PLATE_OPTIONS = {
  kind: "plate_reader" as const,
  options: {
    wavelengths: ["450", "600"],
    measurementModes: ["Absorbance"],
    measurementTypes: ["Endpoint"],
  },
};

describe("validateSearchRunsMetadataFilters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getInstrumentById.mockResolvedValue({
      id: "plate-1",
      instrumentType: "plate_reader",
    });
    getInstrumentFilterOptions.mockResolvedValue(PLATE_OPTIONS);
  });

  it("returns null when no metadata filters are supplied", async () => {
    const result = await validateSearchRunsMetadataFilters("plate-1", {});
    expect(result).toBeNull();
    expect(getInstrumentById).not.toHaveBeenCalled();
  });

  it("accepts a valid value for an applicable key", async () => {
    const result = await validateSearchRunsMetadataFilters("plate-1", {
      wavelength: "450",
    });
    expect(result).toBeNull();
  });

  it("rejects an out-of-enum value for an applicable key", async () => {
    const result = await validateSearchRunsMetadataFilters("plate-1", {
      wavelength: "999",
    });
    expect(result).toContain("Invalid wavelength");
    expect(result).toContain("450");
    expect(result).toContain("filter-options");
  });

  it("rejects a filter that does not apply to the instrument type", async () => {
    // `captureType` is a gel-doc filter; supplying it on a plate reader must
    // be rejected rather than silently ignored.
    const result = await validateSearchRunsMetadataFilters("plate-1", {
      captureType: "Chemi",
    });
    expect(result).toContain("does not apply");
    expect(result).toContain("plate_reader");
  });

  it("skips validation for instruments with no filter enum (default kind)", async () => {
    getInstrumentById.mockResolvedValue({
      id: "generic-1",
      instrumentType: "generic",
    });
    getInstrumentFilterOptions.mockResolvedValue({ kind: "default" });

    const result = await validateSearchRunsMetadataFilters("generic-1", {
      wavelength: "450",
    });
    expect(result).toBeNull();
  });

  it("returns null when the instrument does not exist", async () => {
    getInstrumentById.mockResolvedValue(null);
    const result = await validateSearchRunsMetadataFilters("missing", {
      wavelength: "450",
    });
    expect(result).toBeNull();
  });
});
