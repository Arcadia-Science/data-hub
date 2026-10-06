import { describe, expect, it } from "vitest";
import {
  feedbackAttachmentUrl,
  feedbackReporterMarker,
  feedbackStatusFromLinearState,
  kindFromAttachmentUrl,
  pageFeedbackSummaries,
} from "@/lib/linear/feedback-link";

describe("feedback attachment links", () => {
  it("builds a URL that contains the reporter and the kind", () => {
    const url = feedbackAttachmentUrl({
      origin: "https://datahub.test/",
      reporterId: "user/1",
      kind: "bug",
      issueId: "11111111-1111-4111-8111-111111111111",
    });
    expect(url).toBe(
      "https://datahub.test/feedback/r/user%2F1/k/bug/11111111-1111-4111-8111-111111111111"
    );
    expect(url).toContain(feedbackReporterMarker("user/1"));
    expect(kindFromAttachmentUrl(url)).toBe("bug");
  });

  it("maps Linear state types onto feedback statuses", () => {
    expect(feedbackStatusFromLinearState("completed")).toBe("resolved");
    expect(feedbackStatusFromLinearState("canceled")).toBe("declined");
    expect(feedbackStatusFromLinearState("triage")).toBe("open");
    expect(feedbackStatusFromLinearState("started")).toBe("open");
  });

  it("counts every status and pages the filtered list", () => {
    const page = pageFeedbackSummaries(
      [
        {
          id: "a",
          createdAt: "2026-01-01T00:00:00.000Z",
          kind: "bug",
          status: "open",
        },
        {
          id: "b",
          createdAt: "2026-01-03T00:00:00.000Z",
          kind: "bug",
          status: "resolved",
        },
        {
          id: "c",
          createdAt: "2026-01-02T00:00:00.000Z",
          kind: "other",
          status: "open",
        },
      ],
      { status: "open", kind: "bug", limit: 10, offset: 0 }
    );
    expect(page.counts).toEqual({ open: 2, resolved: 1, declined: 0 });
    expect(page.total).toBe(1);
    expect(page.ids).toEqual(["a"]);
  });
});
