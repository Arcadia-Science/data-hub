import { describe, expect, it } from "vitest";
import {
  isStalledProcessing,
  minutesUntilProcessingIsStalled,
  STALLED_PROCESSING_AFTER_MS,
  stalledProcessingCutoff,
} from "@/lib/runs/stalled-processing";

const now = new Date("2026-08-27T12:00:00.000Z");

describe("isStalledProcessing", () => {
  it("is false for non-processing statuses", () => {
    expect(
      isStalledProcessing(
        { status: "completed", processingStartedAt: null },
        now
      )
    ).toBe(false);
    expect(
      isStalledProcessing({ status: "failed", processingStartedAt: null }, now)
    ).toBe(false);
    expect(
      isStalledProcessing(
        { status: "uploaded", processingStartedAt: null },
        now
      )
    ).toBe(false);
  });

  it("treats a NULL processingStartedAt as stalled", () => {
    expect(
      isStalledProcessing(
        { status: "processing", processingStartedAt: null },
        now
      )
    ).toBe(true);
  });

  it("is false while still inside the stall window", () => {
    expect(
      isStalledProcessing(
        {
          status: "processing",
          processingStartedAt: new Date(now.getTime() - 5 * 60 * 1000),
        },
        now
      )
    ).toBe(false);
  });

  it("is true once processing has exceeded the stall window", () => {
    expect(
      isStalledProcessing(
        {
          status: "processing",
          processingStartedAt: new Date(
            now.getTime() - STALLED_PROCESSING_AFTER_MS - 1
          ),
        },
        now
      )
    ).toBe(true);
  });
});

describe("stalledProcessingCutoff", () => {
  it("is STALLED_PROCESSING_AFTER_MS before now", () => {
    expect(stalledProcessingCutoff(now).getTime()).toBe(
      now.getTime() - STALLED_PROCESSING_AFTER_MS
    );
  });
});

describe("minutesUntilProcessingIsStalled", () => {
  it("rounds remaining time up to whole minutes", () => {
    expect(
      minutesUntilProcessingIsStalled(
        { processingStartedAt: new Date(now.getTime() - 30 * 1000) },
        now
      )
    ).toBe(20);
  });

  it("never returns less than 1", () => {
    expect(
      minutesUntilProcessingIsStalled(
        {
          processingStartedAt: new Date(
            now.getTime() - STALLED_PROCESSING_AFTER_MS + 100
          ),
        },
        now
      )
    ).toBe(1);
  });
});
