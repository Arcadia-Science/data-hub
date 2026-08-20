import { describe, expect, it } from "vitest";
import { mimeFor, parseByteRange } from "@/lib/s3-local-mirror";

describe("parseByteRange", () => {
  it("serves the full file when Range is missing or malformed", () => {
    expect(parseByteRange(null, 100)).toEqual({ kind: "full" });
    expect(parseByteRange("bytes=", 100)).toEqual({ kind: "full" });
    expect(parseByteRange("wibble", 100)).toEqual({ kind: "full" });
  });

  it("parses open-ended and closed ranges", () => {
    expect(parseByteRange("bytes=0-1", 100)).toEqual({
      kind: "partial",
      start: 0,
      end: 1,
    });
    expect(parseByteRange("bytes=50-", 100)).toEqual({
      kind: "partial",
      start: 50,
      end: 99,
    });
    expect(parseByteRange("bytes=-10", 100)).toEqual({
      kind: "partial",
      start: 90,
      end: 99,
    });
  });

  it("rejects ranges past the end of the file", () => {
    expect(parseByteRange("bytes=100-101", 100)).toEqual({
      kind: "unsatisfiable",
    });
    expect(parseByteRange("bytes=0-1", 0)).toEqual({
      kind: "unsatisfiable",
    });
  });
});

describe("mimeFor", () => {
  it("maps mp4 to video/mp4 so the local player can seek", () => {
    expect(mimeFor("/tmp/stack.mp4")).toBe("video/mp4");
  });
});
