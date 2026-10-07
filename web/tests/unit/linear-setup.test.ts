import { describe, expect, it } from "vitest";
import {
  type FeedbackItem,
  issueDescription,
  presentFeedback,
} from "@/lib/api/feedback";
import {
  LINEAR_WEBHOOK_IPS,
  linearWebhookRejectionReason,
} from "@/lib/linear/webhook";

const LINEAR_IP = [...LINEAR_WEBHOOK_IPS][0] ?? "";

describe("issueDescription", () => {
  it("uses the same field names as the form and the detail sheet", () => {
    const text = issueDescription({
      kind: "feature_request",
      description: "Export the plate.",
      attemptedAction: "Download the run",
      errorMessage: "Network error",
      toolName: "get_run_report",
      pageUrl: "https://datahub.test/runs/1",
      reporterEmail: "ada@example.com",
      reporterId: "user-1",
      reporterName: "Ada",
      source: "web",
    });
    expect(text).toContain("Type: Feature request");
    expect(text).toContain("Trying to do: Download the run");
    expect(text).toContain("Error message: Network error");
    expect(text).toContain("Tool: get_run_report");
    expect(text).toContain("Page: https://datahub.test/runs/1");
    expect(text).not.toContain("Kind:");
    expect(text).not.toContain("Tried:");
  });
});

describe("linear webhook rejections", () => {
  it("counts a bad signature only from Linear's addresses and this workspace", () => {
    expect(
      linearWebhookRejectionReason({
        signatureOk: false,
        fresh: false,
        ip: LINEAR_IP,
        organizationId: "org-1",
        savedWorkspaceId: "org-1",
      })
    ).toBe("signature");
    expect(
      linearWebhookRejectionReason({
        signatureOk: true,
        fresh: false,
        ip: LINEAR_IP,
        organizationId: "org-1",
        savedWorkspaceId: "org-1",
      })
    ).toBe("stale");
  });

  it("ignores a rejection that did not come from Linear", () => {
    expect(
      linearWebhookRejectionReason({
        signatureOk: false,
        fresh: true,
        ip: "203.0.113.4",
        organizationId: "org-1",
        savedWorkspaceId: "org-1",
      })
    ).toBeNull();
    expect(
      linearWebhookRejectionReason({
        signatureOk: false,
        fresh: true,
        ip: LINEAR_IP,
        organizationId: "someone-else",
        savedWorkspaceId: "org-1",
      })
    ).toBeNull();
  });

  it("does not treat a valid delivery as a rejection", () => {
    expect(
      linearWebhookRejectionReason({
        signatureOk: true,
        fresh: true,
        ip: LINEAR_IP,
        organizationId: "org-1",
        savedWorkspaceId: "org-1",
      })
    ).toBeNull();
  });
});

describe("presentFeedback", () => {
  const item = {
    activity: [
      {
        kind: "comment",
        at: "2026-01-01T00:00:00.000Z",
        actorName: "Ada",
        body: "Internal note",
        fromState: null,
        toState: null,
      },
    ],
    linearIssue: {
      assignee: {
        userId: "user-2",
        name: "Ada",
        email: "ada@example.com",
        avatarUrl: null,
      },
      priority: 2,
      priorityLabel: "High",
      identifier: "DH-1",
      labels: [{ name: "Bug", color: "#eb5757" }],
      stateName: "Todo",
    },
  } as FeedbackItem;

  it("hides assignee, priority, and activity from the reporter", () => {
    const shown = presentFeedback(item, false);
    expect(shown.activity).toBeNull();
    expect(shown.linearIssue.assignee).toBeNull();
    expect(shown.linearIssue.priority).toBeNull();
    expect(shown.linearIssue.priorityLabel).toBeNull();
    expect(shown.linearIssue.labels).toEqual(item.linearIssue.labels);
    expect(shown.linearIssue.stateName).toBe("Todo");
  });

  it("leaves an admin's report intact", () => {
    expect(presentFeedback(item, true)).toBe(item);
  });
});
