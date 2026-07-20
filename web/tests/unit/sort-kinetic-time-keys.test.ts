import { describe, expect, it } from "vitest";
import { sortTimeKeys } from "@/lib/runs/sort-kinetic-time-keys";

describe("sortTimeKeys", () => {
  it("sorts SoftMax multi-day elapsed times chronologically", () => {
    const keys = [
      "2.02:11:12",
      "01:50:24",
      "03:00:39",
      "1.00:15:25",
      "00:00:00",
      "23:55:00",
    ];
    expect(sortTimeKeys(keys)).toEqual([
      "00:00:00",
      "01:50:24",
      "03:00:39",
      "23:55:00",
      "1.00:15:25",
      "2.02:11:12",
    ]);
  });

  it("keeps same-day HH:MM:SS order", () => {
    expect(sortTimeKeys(["01:50:24", "00:00:00", "00:15:00"])).toEqual([
      "00:00:00",
      "00:15:00",
      "01:50:24",
    ]);
  });

  it("sorts numeric scan indices numerically", () => {
    expect(sortTimeKeys(["10", "2", "1"])).toEqual(["1", "2", "10"]);
  });

  it("deduplicates keys", () => {
    expect(sortTimeKeys(["00:00:00", "00:00:00", "01:00:00"])).toEqual([
      "00:00:00",
      "01:00:00",
    ]);
  });
});
