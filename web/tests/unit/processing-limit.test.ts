import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROCESSING_CONCURRENCY_LIMIT,
  processingConcurrencyLimit,
} from "@/lib/runs/processing-limit";

const originalEnv = process.env.PROCESSING_CONCURRENCY_LIMIT;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.PROCESSING_CONCURRENCY_LIMIT;
  } else {
    process.env.PROCESSING_CONCURRENCY_LIMIT = originalEnv;
  }
});

describe("processingConcurrencyLimit", () => {
  it("defaults to 10 when the env var is unset", () => {
    delete process.env.PROCESSING_CONCURRENCY_LIMIT;
    expect(DEFAULT_PROCESSING_CONCURRENCY_LIMIT).toBe(10);
    expect(processingConcurrencyLimit()).toBe(10);
  });

  it("reads a positive whole number from PROCESSING_CONCURRENCY_LIMIT", () => {
    process.env.PROCESSING_CONCURRENCY_LIMIT = "3";
    expect(processingConcurrencyLimit()).toBe(3);
  });

  it("trims whitespace around the env value", () => {
    process.env.PROCESSING_CONCURRENCY_LIMIT = "  25  ";
    expect(processingConcurrencyLimit()).toBe(25);
  });

  it("falls back to the default for empty, zero, negative, fractional, or non-numeric values", () => {
    for (const value of ["", "0", "-1", "2.5", "abc"]) {
      process.env.PROCESSING_CONCURRENCY_LIMIT = value;
      expect(processingConcurrencyLimit()).toBe(
        DEFAULT_PROCESSING_CONCURRENCY_LIMIT
      );
    }
  });
});
