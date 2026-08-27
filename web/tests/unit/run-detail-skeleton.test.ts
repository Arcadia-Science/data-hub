import { describe, expect, it } from "vitest";
import { VALID_INSTRUMENT_TYPES } from "@/lib/db/schema";
import { showsReportDataSection } from "@/lib/runs/report-items";

// The loading placeholder has to match what the loaded page renders, or the
// page shifts. A new instrument type whose page shows something other than
// "Report Data" needs adding here and to `showsReportDataSection`.
const NO_REPORT_SECTION = new Set(["plate_reader"]);

describe("showsReportDataSection", () => {
  it("skips only the plate reader, which shows Plate Maps instead", () => {
    for (const instrumentType of VALID_INSTRUMENT_TYPES) {
      expect(showsReportDataSection(instrumentType)).toBe(
        !NO_REPORT_SECTION.has(instrumentType)
      );
    }
  });

  it("covers the viewers that always render a report shell", () => {
    expect(showsReportDataSection("instant_raman")).toBe(true);
    expect(showsReportDataSection("aunty")).toBe(true);
    expect(showsReportDataSection("dishcam")).toBe(true);
  });
});
