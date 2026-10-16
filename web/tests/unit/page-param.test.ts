import { describe, expect, it } from "vitest";
import { decodePageParam } from "@/lib/runs/page-param";

describe("decodePageParam", () => {
  it("decodes escapes that a page receives", () => {
    expect(decodePageParam("run%201")).toBe("run 1");
    expect(decodePageParam("a%23b%3Fc%2Fd")).toBe("a#b?c/d");
    expect(decodePageParam("100%25")).toBe("100%");
  });

  it("leaves a plain value alone", () => {
    expect(decodePageParam("2026-03-26_experiment")).toBe(
      "2026-03-26_experiment"
    );
  });

  it("keeps a stray percent sign instead of throwing", () => {
    expect(decodePageParam("100%")).toBe("100%");
    expect(decodePageParam("%E0%A4%A")).toBe("%E0%A4%A");
  });
});
