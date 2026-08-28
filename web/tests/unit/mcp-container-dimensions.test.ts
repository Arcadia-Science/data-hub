import { describe, expect, it } from "vitest";
import { documentStylesForContainerDimensions } from "@/mcp-apps/run-report/host-bridge";

describe("documentStylesForContainerDimensions", () => {
  it("leaves height unbounded when neither height nor maxHeight is set", () => {
    expect(documentStylesForContainerDimensions({ width: 640 })).toMatchObject({
      height: "",
      maxHeight: "",
      overflow: "",
    });
  });

  it("fills a host-fixed height", () => {
    expect(
      documentStylesForContainerDimensions({ width: 640, height: 800 })
    ).toMatchObject({
      height: "100vh",
      minHeight: "100%",
      overflow: "auto",
    });
  });

  it("caps flexible height so the View can scroll instead of growing past maxHeight", () => {
    expect(
      documentStylesForContainerDimensions({ width: 640, maxHeight: 720 })
    ).toEqual({
      height: "",
      maxHeight: "720px",
      minHeight: "",
      overflow: "auto",
      width: "100%",
      maxWidth: "",
    });
  });

  it("treats maxHeight 0 as omitted", () => {
    expect(
      documentStylesForContainerDimensions({ width: 400, maxHeight: 0 })
    ).toMatchObject({
      maxHeight: "",
      overflow: "",
    });
  });
});
