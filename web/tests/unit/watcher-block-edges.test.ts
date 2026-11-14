import { describe, expect, it } from "vitest";
import { BLOCKS_PER_DAY, blockEdges } from "@/lib/watchers/block-edges";
import { classifyBlock } from "@/lib/watchers/health";

const LA = "America/Los_Angeles";
const HOUR = 60 * 60 * 1000;
const iso = (date: Date) => date.toISOString().slice(0, 16);

/** The length of each of the day's blocks, in minutes. */
function lengths(edges: Date[]): number[] {
  return edges
    .slice(1)
    .map((edge, i) => (edge.getTime() - edges[i].getTime()) / 60_000);
}

describe("blockEdges", () => {
  it("is 49 edges of 30 minutes on an ordinary day", () => {
    const edges = blockEdges("2026-03-10", LA);
    expect(edges).toHaveLength(BLOCKS_PER_DAY + 1);
    expect(iso(edges[0])).toBe("2026-03-10T07:00");
    expect(iso(edges[48])).toBe("2026-03-11T07:00");
    expect(new Set(lengths(edges))).toEqual(new Set([30]));
  });

  it("is the same in a zone with no daylight time", () => {
    const edges = blockEdges("2026-03-08", "UTC");
    expect(new Set(lengths(edges))).toEqual(new Set([30]));
    expect(iso(edges[48])).toBe("2026-03-09T00:00");
  });

  describe("the day the clocks go forward", () => {
    // 2026-03-08 in Los Angeles: 02:00 PST is 03:00 PDT, so the day has 23 hours
    // and the wall-clock times 2:00 and 2:30 AM never happen.
    const edges = blockEdges("2026-03-08", LA);

    it("runs from midnight to the next midnight, 23 hours", () => {
      expect(iso(edges[0])).toBe("2026-03-08T08:00");
      expect(iso(edges[48])).toBe("2026-03-09T07:00");
      expect((edges[48].getTime() - edges[0].getTime()) / HOUR).toBe(23);
    });

    it("never goes backwards", () => {
      for (let i = 1; i < edges.length; i++) {
        expect(edges[i].getTime()).toBeGreaterThanOrEqual(
          edges[i - 1].getTime()
        );
      }
    });

    it("gives the blocks for 2:00 and 2:30 AM no time at all", () => {
      const sizes = lengths(edges);
      expect(sizes.slice(0, 8)).toEqual([30, 30, 30, 30, 0, 0, 30, 30]);
      // The block for 1:30 AM ends where the clock jumps, at 10:00 UTC, and
      // 3:00 AM starts there.
      expect(iso(edges[3])).toBe("2026-03-08T09:30");
      expect(iso(edges[4])).toBe("2026-03-08T10:00");
      expect(iso(edges[5])).toBe("2026-03-08T10:00");
      expect(iso(edges[6])).toBe("2026-03-08T10:00");
    });

    it("draws the skipped blocks as no data, and the ones around them as they are", () => {
      // A watcher that checks in every minute: 3 AM onward has heartbeats, and
      // the blocks that hold no time can hold none.
      const now = new Date("2026-03-10T00:00:00Z");
      const state = (slot: number, heartbeats: number) =>
        classifyBlock({
          start: edges[slot],
          end: edges[slot + 1],
          now,
          heartbeats,
          firstHeartbeatAt: new Date("2026-03-01T00:00:00Z"),
          deregisteredAt: null,
          restarted: false,
          missed: false,
          stoppedBefore: false,
        });
      expect(state(3, 30).state).toBe("checked_in");
      expect(state(4, 0)).toEqual({ state: "no_data", noData: "skipped" });
      expect(state(5, 0)).toEqual({ state: "no_data", noData: "skipped" });
      expect(state(6, 30).state).toBe("checked_in");
    });
  });

  describe("the day the clocks go back", () => {
    // 2026-11-01 in Los Angeles: the hour from 1:00 to 2:00 AM happens twice,
    // so the day has 25 hours.
    const edges = blockEdges("2026-11-01", LA);

    it("runs from midnight to the next midnight, 25 hours", () => {
      expect(iso(edges[0])).toBe("2026-11-01T07:00");
      expect(iso(edges[48])).toBe("2026-11-02T08:00");
      expect((edges[48].getTime() - edges[0].getTime()) / HOUR).toBe(25);
    });

    it("never goes backwards, and covers the day without a gap", () => {
      for (let i = 1; i < edges.length; i++) {
        expect(edges[i].getTime()).toBeGreaterThan(edges[i - 1].getTime());
      }
      expect(lengths(edges).reduce((sum, minutes) => sum + minutes, 0)).toBe(
        25 * 60
      );
    });

    it("starts each wall-clock time when it first happens, so the repeated hour is held by the blocks for 1:00 and 1:30 AM", () => {
      // 1:00 AM PDT, 1:30 AM PDT, then 2:00 AM PST: the block for 1:30 AM
      // holds the repeated hour as well.
      expect(iso(edges[2])).toBe("2026-11-01T08:00");
      expect(iso(edges[3])).toBe("2026-11-01T08:30");
      expect(iso(edges[4])).toBe("2026-11-01T10:00");
      expect(lengths(edges).slice(0, 6)).toEqual([30, 30, 30, 90, 30, 30]);
    });
  });

  it("handles a clock change of half an hour", () => {
    // Lord Howe Island moves its clocks by 30 minutes; its day is 23.5 hours.
    const edges = blockEdges("2026-10-04", "Australia/Lord_Howe");
    expect(edges).toHaveLength(BLOCKS_PER_DAY + 1);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i].getTime()).toBeGreaterThanOrEqual(edges[i - 1].getTime());
    }
    expect((edges[48].getTime() - edges[0].getTime()) / HOUR).toBe(23.5);
  });
});
