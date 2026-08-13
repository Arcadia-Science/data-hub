import { describe, expect, it } from "vitest";
import { sortWavelengths } from "@/components/runs/metadata-badges";

describe("sortWavelengths", () => {
  it("sorts numeric wavelengths ascending", () => {
    expect(sortWavelengths(["750", "600", "650"])).toEqual([
      "600",
      "650",
      "750",
    ]);
  });

  it("sorts Spectrum range tokens by start nm", () => {
    expect(sortWavelengths(["480–500", "430–440", "440–450"])).toEqual([
      "430–440",
      "440–450",
      "480–500",
    ]);
  });

  it("places range tokens among discrete wavelengths by start", () => {
    expect(sortWavelengths(["595", "440–450", "400"])).toEqual([
      "400",
      "440–450",
      "595",
    ]);
  });
});
