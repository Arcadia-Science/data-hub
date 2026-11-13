import { describe, expect, it } from "vitest";
import {
  lookupRunByNaturalKey,
  lookupRunUuidsByNaturalKeys,
  normalizeRunId,
} from "@/lib/api/instrument-runs";

describe("normalizeRunId", () => {
  it("removes spaces at the start and the end", () => {
    expect(normalizeRunId(" RUN1")).toBe("RUN1");
    expect(normalizeRunId("RUN1 ")).toBe("RUN1");
    expect(normalizeRunId("  RUN1   ")).toBe("RUN1");
  });

  it("removes tabs and line breaks at the ends", () => {
    expect(normalizeRunId("\tRUN1\r\n")).toBe("RUN1");
  });

  it("keeps spaces inside the ID", () => {
    expect(normalizeRunId(" run 1 ")).toBe("run 1");
  });

  it("leaves an ID that has no outer spaces alone", () => {
    expect(normalizeRunId("RUN1")).toBe("RUN1");
    expect(normalizeRunId("a#b?c%41")).toBe("a#b?c%41");
  });

  it("turns an ID that is only spaces into an empty string", () => {
    expect(normalizeRunId("   ")).toBe("");
    expect(normalizeRunId("")).toBe("");
  });
});

// The test setup replaces the database with an empty object, so a lookup that
// reaches the database throws. These pass only when the lookup stops first.
describe("run lookups with an ID that is only spaces", () => {
  it("lookupRunByNaturalKey finds nothing", async () => {
    await expect(lookupRunByNaturalKey("some-instrument", "   ")).resolves.toBe(
      null
    );
    await expect(lookupRunByNaturalKey("some-instrument", "")).resolves.toBe(
      null
    );
  });

  it("lookupRunUuidsByNaturalKeys finds nothing", async () => {
    const found = await lookupRunUuidsByNaturalKeys("some-instrument", [
      "   ",
      "",
      "\t",
    ]);
    expect(found.size).toBe(0);
  });
});
