import { describe, expect, it } from "vitest";
import {
  commentAnchorId,
  commentHash,
  isCommentHash,
  runCommentHref,
} from "@/lib/comment-hash";

describe("comment hash helpers", () => {
  it("builds a #comment-{id} fragment, not a bare id", () => {
    expect(commentAnchorId("abc")).toBe("comment-abc");
    expect(commentHash("abc")).toBe("#comment-abc");
    expect(isCommentHash("#comment-abc")).toBe(true);
    expect(isCommentHash("#abc")).toBe(false);
  });

  it("appends the fragment only when a comment id is present", () => {
    expect(runCommentHref("inst-1", "run-1")).toBe(
      "/instruments/inst-1/runs/run-1"
    );
    expect(runCommentHref("inst-1", "run-1", null)).toBe(
      "/instruments/inst-1/runs/run-1"
    );
    expect(runCommentHref("inst-1", "run-1", "c1")).toBe(
      "/instruments/inst-1/runs/run-1#comment-c1"
    );
  });

  it("encodes the run id so slashes stay in one path segment", () => {
    expect(runCommentHref("inst-1", "run/a", "c1")).toBe(
      "/instruments/inst-1/runs/run%2Fa#comment-c1"
    );
  });
});
