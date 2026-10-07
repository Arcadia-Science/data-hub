// How a Data Hub feedback report is recognized inside Linear.
//
// Each issue gets one attachment whose URL contains the reporter id and the
// kind. List queries filter on that URL, so Data Hub never has to store the
// issue id itself.

import {
  type FeedbackKind,
  type FeedbackStatus,
  feedbackKindSchema,
} from "@/lib/api/feedback-schema";

export const FEEDBACK_REPORT_MARKER = "/feedback/r/";

// A report is closed once its issue reaches one of these Linear state types.
// `duplicate` is a type of its own in Linear, next to `completed` and
// `canceled`, and a team can map its "Duplicate" state to it.
export const LINEAR_CLOSED_STATE_TYPES = [
  "completed",
  "canceled",
  "duplicate",
] as const;

export function feedbackReporterMarker(reporterId: string): string {
  return `${FEEDBACK_REPORT_MARKER}${encodeURIComponent(reporterId)}/`;
}

export function feedbackAttachmentUrl(input: {
  issueId: string;
  kind: FeedbackKind;
  origin: string;
  reporterId: string;
}): string {
  const origin = input.origin.replace(/\/$/, "");
  return `${origin}${feedbackReporterMarker(input.reporterId)}k/${input.kind}/${input.issueId}`;
}

// A line in the issue description that exists before the attachment does. If
// the attachment call fails, a retry searches for this line to finish the
// same issue instead of opening a second one.
export function feedbackIssueMarker(input: {
  kind: FeedbackKind;
  reporterId: string;
}): string {
  return `Data Hub report: ${encodeURIComponent(input.reporterId)} / ${input.kind}`;
}

export function kindFromAttachmentUrl(url: string): FeedbackKind | null {
  const kind = feedbackKindSchema.safeParse(/\/k\/([^/]+)\//.exec(url)?.[1]);
  return kind.success ? kind.data : null;
}

export function feedbackStatusFromLinearState(type: string): FeedbackStatus {
  if (type === "completed") {
    return "resolved";
  }
  if (type === "canceled" || type === "duplicate") {
    return "declined";
  }
  return "open";
}

export interface FeedbackSummary {
  createdAt: string;
  id: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
}

export function pageFeedbackSummaries(
  items: FeedbackSummary[],
  input: {
    kind?: FeedbackKind;
    limit: number;
    offset: number;
    status?: FeedbackStatus;
  }
): {
  counts: Record<FeedbackStatus, number>;
  ids: string[];
  total: number;
} {
  const counts: Record<FeedbackStatus, number> = {
    open: 0,
    resolved: 0,
    declined: 0,
  };
  for (const item of items) {
    counts[item.status] += 1;
  }

  const filtered = items
    .filter((item) => (input.status ? item.status === input.status : true))
    .filter((item) => (input.kind ? item.kind === input.kind : true))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return {
    counts,
    total: filtered.length,
    ids: filtered
      .slice(input.offset, input.offset + input.limit)
      .map((item) => item.id),
  };
}
