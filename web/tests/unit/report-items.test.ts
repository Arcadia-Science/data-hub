import { describe, expect, it } from "vitest";
import {
  isReportItemKind,
  REPORT_ITEM_KINDS,
  reportItemKindForInstrument,
} from "@/lib/runs/report-items";

describe("reportItemKindForInstrument", () => {
  it("maps dishcam runs to the video seeker", () => {
    expect(reportItemKindForInstrument("dishcam")).toBe("video");
  });

  it("leaves unmapped types without a seeker", () => {
    expect(reportItemKindForInstrument("generic")).toBeNull();
    expect(reportItemKindForInstrument("plate_reader")).toBeNull();
    expect(reportItemKindForInstrument("aunty")).toBeNull();
  });
});

describe("isReportItemKind", () => {
  it("accepts every documented kind", () => {
    expect(REPORT_ITEM_KINDS).toContain("video");
    for (const kind of REPORT_ITEM_KINDS) {
      expect(isReportItemKind(kind)).toBe(true);
    }
  });
});
