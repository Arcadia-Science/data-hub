import { describe, expect, it } from "vitest";
import { feedbackKindSchema } from "@/lib/api/feedback-schema";
import {
  FEEDBACK_REPORT_MARKER,
  feedbackAttachmentUrl,
  feedbackIssueMarker,
  feedbackReporterMarker,
  feedbackStatusFromLinearState,
  isLinearStateClosed,
  kindFromAttachmentUrl,
  pageFeedbackSummaries,
  readFeedbackReport,
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

  it("builds the reporter marker from the shared report marker", () => {
    expect(feedbackReporterMarker("user/1")).toBe(
      `${FEEDBACK_REPORT_MARKER}user%2F1/`
    );
  });

  it("reads every kind back from its own URL, and nothing else", () => {
    for (const kind of feedbackKindSchema.options) {
      const url = feedbackAttachmentUrl({
        origin: "https://datahub.test",
        reporterId: "user-1",
        kind,
        issueId: "issue-1",
      });
      expect(kindFromAttachmentUrl(url)).toBe(kind);
    }
    expect(
      kindFromAttachmentUrl("https://datahub.test/feedback/r/u/k/praise/i")
    ).toBeNull();
    expect(kindFromAttachmentUrl("https://github.com/o/r/pull/1")).toBeNull();
  });

  it("writes an issue marker that tells reporters and kinds apart", () => {
    const marker = feedbackIssueMarker({ reporterId: "abc", kind: "bug" });
    expect(marker).not.toBe(
      feedbackIssueMarker({ reporterId: "abc", kind: "other" })
    );
    // One reporter id that starts with another must not match its marker.
    expect(
      feedbackIssueMarker({ reporterId: "abc2", kind: "bug" })
    ).not.toContain(marker);
  });

  it("maps Linear state types onto feedback statuses", () => {
    expect(feedbackStatusFromLinearState("completed")).toBe("resolved");
    expect(feedbackStatusFromLinearState("canceled")).toBe("declined");
    expect(feedbackStatusFromLinearState("duplicate")).toBe("declined");
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

  it("treats completed, canceled, and duplicate as closed", () => {
    for (const type of ["completed", "canceled", "duplicate"]) {
      expect(isLinearStateClosed(type)).toBe(true);
    }
    for (const type of ["triage", "backlog", "unstarted", "started"]) {
      expect(isLinearStateClosed(type)).toBe(false);
    }
  });

  it("reads the report from the Data Hub attachment and ignores the rest", () => {
    const metadata = {
      version: 1,
      reporterUserId: "user-1",
      kind: "bug",
      title: "Export fails",
      description: "Stops halfway.",
      source: "web",
    };
    const pullRequest = {
      url: "https://github.com/o/r/pull/1",
      metadata: { reviews: [{ state: "approved" }], status: { merged: false } },
    };
    const report = {
      url: "https://datahub.test/feedback/r/user-1/k/bug/issue-1",
      metadata,
    };

    expect(
      readFeedbackReport({ attachments: { nodes: [pullRequest, report] } })
    ).toMatchObject({ reporterUserId: "user-1", title: "Export fails" });
    expect(
      readFeedbackReport({ attachments: { nodes: [pullRequest] } })
    ).toBeNull();
    expect(
      readFeedbackReport({
        attachments: {
          nodes: [{ ...report, metadata: { ...metadata, kind: "praise" } }],
        },
      })
    ).toBeNull();
  });
});
