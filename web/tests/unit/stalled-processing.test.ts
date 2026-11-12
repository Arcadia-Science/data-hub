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

  it("reads a longer window from STALLED_PROCESSING_AFTER_MINUTES", () => {
    process.env.STALLED_PROCESSING_AFTER_MINUTES = "45";
    expect(stalledProcessingAfterMs()).toBe(45 * 60 * 1000);
  });

  it("trims whitespace around the env value", () => {
    process.env.STALLED_PROCESSING_AFTER_MINUTES = "  30  ";
    expect(stalledProcessingAfterMs()).toBe(30 * 60 * 1000);
  });

  it("raises a window shorter than the default to the default", () => {
    // Lambda can run for 15 minutes, so a shorter window would count a
    // running Lambda as stalled.
    for (const value of ["1", "5", "15", "19.5"]) {
      process.env.STALLED_PROCESSING_AFTER_MINUTES = value;
      expect(stalledProcessingAfterMs()).toBe(
        DEFAULT_STALLED_PROCESSING_AFTER_MS
      );
    }
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
    process.env.STALLED_PROCESSING_AFTER_MINUTES = "30";
    const started = new Date(now.getTime() - 25 * 60 * 1000);
    expect(
      isStalledProcessing(
        { status: "processing", processingStartedAt: started },
        now
      )
    ).toBe(false);

    process.env.STALLED_PROCESSING_AFTER_MINUTES = "20";
    expect(
      isStalledProcessing(
        { status: "processing", processingStartedAt: started },
        now
      )
    ).toBe(true);
  });

  it("does not count a start younger than 20 minutes as stalled, even with a shorter window set", () => {
    process.env.STALLED_PROCESSING_AFTER_MINUTES = "5";
    expect(
      isStalledProcessing(
        {
          status: "processing",
          processingStartedAt: new Date(now.getTime() - 16 * 60 * 1000),
        },
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
      minutesUntilProcessingIsStalled(new Date(now.getTime() - 30 * 1000), now)
    ).toBe(Math.ceil(stalledProcessingAfterMs() / 60_000));
  });

  it("never returns less than 1", () => {
    expect(
      minutesUntilProcessingIsStalled(
        new Date(now.getTime() - stalledProcessingAfterMs() + 100),
        now
      )
    ).toBe(1);
  });
});
