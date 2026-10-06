// How a Data Hub feedback report is recognized inside Linear.
//
// Each issue gets one attachment whose URL contains the reporter id and the
// kind. List queries filter on that URL, so Data Hub never has to store the
// issue id itself.

import type { FeedbackKind, FeedbackStatus } from "@/lib/api/feedback-schema";

const KIND_PATTERN = /\/k\/(bug|feature_request|other)\//;

export function feedbackReporterMarker(reporterId: string): string {
  return `/feedback/r/${encodeURIComponent(reporterId)}/`;
}

export const FEEDBACK_REPORT_MARKER = "/feedback/r/";

export function feedbackAttachmentUrl(input: {
  issueId: string;
  kind: FeedbackKind;
  origin: string;
  reporterId: string;
}): string {
  const origin = input.origin.replace(/\/$/, "");
  return `${origin}${feedbackReporterMarker(input.reporterId)}k/${input.kind}/${input.issueId}`;
}

export function kindFromAttachmentUrl(url: string): FeedbackKind | null {
  const match = KIND_PATTERN.exec(url);
  if (!match) {
    return null;
  }
  return match[1] as FeedbackKind;
}

export function feedbackStatusFromLinearState(type: string): FeedbackStatus {
  if (type === "completed") {
    return "resolved";
  }
  if (type === "canceled") {
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
