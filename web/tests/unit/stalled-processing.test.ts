import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STALLED_PROCESSING_AFTER_MS,
  isStalledProcessing,
  minutesUntilProcessingIsStalled,
  stalledProcessingAfterMs,
  stalledProcessingCutoff,
} from "@/lib/runs/stalled-processing";

const now = new Date("2026-08-27T12:00:00.000Z");
const originalEnv = process.env.STALLED_PROCESSING_AFTER_MINUTES;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.STALLED_PROCESSING_AFTER_MINUTES;
  } else {
    process.env.STALLED_PROCESSING_AFTER_MINUTES = originalEnv;
  }
});

describe("stalledProcessingAfterMs", () => {
  it("defaults to 20 minutes when the env var is unset", () => {
    delete process.env.STALLED_PROCESSING_AFTER_MINUTES;
    expect(stalledProcessingAfterMs()).toBe(
      DEFAULT_STALLED_PROCESSING_AFTER_MS
    );
  });

  it("reads a positive minute count from STALLED_PROCESSING_AFTER_MINUTES", () => {
    process.env.STALLED_PROCESSING_AFTER_MINUTES = "5";
    expect(stalledProcessingAfterMs()).toBe(5 * 60 * 1000);
  });

  it("trims whitespace around the env value", () => {
    process.env.STALLED_PROCESSING_AFTER_MINUTES = "  10  ";
    expect(stalledProcessingAfterMs()).toBe(10 * 60 * 1000);
  });

  it("falls back to the default for empty, zero, negative, or non-numeric values", () => {
    for (const value of ["", "0", "-1", "abc"]) {
      process.env.STALLED_PROCESSING_AFTER_MINUTES = value;
      expect(stalledProcessingAfterMs()).toBe(
        DEFAULT_STALLED_PROCESSING_AFTER_MS
      );
    }
  });
});

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
            now.getTime() - stalledProcessingAfterMs() - 1
          ),
        },
        now
      )
    ).toBe(true);
  });

  it("uses the configured stall window", () => {
    process.env.STALLED_PROCESSING_AFTER_MINUTES = "5";
    const started = new Date(now.getTime() - 6 * 60 * 1000);
    expect(
      isStalledProcessing(
        { status: "processing", processingStartedAt: started },
        now
      )
    ).toBe(true);

    process.env.STALLED_PROCESSING_AFTER_MINUTES = "10";
    expect(
      isStalledProcessing(
        { status: "processing", processingStartedAt: started },
        now
      )
    ).toBe(false);
  });
});

describe("stalledProcessingCutoff", () => {
  it("is stalledProcessingAfterMs before now", () => {
    expect(stalledProcessingCutoff(now).getTime()).toBe(
      now.getTime() - stalledProcessingAfterMs()
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
    ).toBe(Math.ceil(stalledProcessingAfterMs() / 60_000));
  });

  it("never returns less than 1", () => {
    expect(
      minutesUntilProcessingIsStalled(
        {
          processingStartedAt: new Date(
            now.getTime() - stalledProcessingAfterMs() + 100
          ),
        },
        now
      )
    ).toBe(1);
  });
});
