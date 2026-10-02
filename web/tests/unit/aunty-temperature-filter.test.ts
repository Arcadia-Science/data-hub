import { describe, expect, it } from "vitest";
import {
  decodeAuntyTemperatureFilter,
  encodeAuntyTemperatureFilter,
} from "@/lib/runs/aunty-temperature-filter";

describe("Aunty temperature filter", () => {
  it("round-trips a start/end pair", () => {
    const value = encodeAuntyTemperatureFilter("25", "95");
    expect(value).toBe("25|95");
    expect(decodeAuntyTemperatureFilter(value)).toEqual({
      kind: "range",
      start: "25",
      end: "95",
    });
  });

  it("treats a bare value as a hold temperature", () => {
    expect(decodeAuntyTemperatureFilter("37")).toEqual({
      kind: "hold",
      value: "37",
    });
  });

  it("rejects malformed pairs", () => {
    expect(decodeAuntyTemperatureFilter("")).toBeNull();
    expect(decodeAuntyTemperatureFilter("|95")).toBeNull();
    expect(decodeAuntyTemperatureFilter("25|")).toBeNull();
    expect(decodeAuntyTemperatureFilter("25|50|95")).toBeNull();
  });
});
