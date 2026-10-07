// How a Data Hub feedback report is recognized inside Linear.
//
// Each issue gets one attachment whose URL contains the reporter id and the
// kind. List queries filter on that URL, so Data Hub never has to store the
// issue id itself.

import { z } from "zod";
import {
  type FeedbackKind,
  type FeedbackListStatus,
  type FeedbackStatus,
  feedbackKindSchema,
  feedbackSourceSchema,
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

export function isLinearStateClosed(type: string): boolean {
  return (LINEAR_CLOSED_STATE_TYPES as readonly string[]).includes(type);
}

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

// The metadata Data Hub writes on a report's attachment. Both the list views
// and the webhook read it through `readFeedbackReport`, so they cannot disagree
// about what counts as a report.
export const feedbackReportMetadataSchema = z.object({
  attemptedAction: z.string().optional(),
  description: z.string(),
  errorMessage: z.string().optional(),
  kind: feedbackKindSchema,
  oauthClientId: z.string().optional(),
  pageUrl: z.string().optional(),
  reporterUserId: z.string(),
  source: feedbackSourceSchema,
  // 1 when the report was sent from Linear setup. Absent on a normal report.
  test: z.number().optional(),
  title: z.string(),
  toolName: z.string().optional(),
  version: z.number(),
});

export type FeedbackReportMetadata = z.infer<
  typeof feedbackReportMetadataSchema
>;

// Returns the checked metadata of the issue's Data Hub attachment, or null
// when the issue is not a Data Hub report. Other integrations' attachments
// are never parsed.
export function readFeedbackReport(issue: {
  attachments: { nodes: { metadata: Record<string, unknown>; url: string }[] };
}): FeedbackReportMetadata | null {
  const attachment = issue.attachments.nodes.find((node) =>
    node.url.includes(FEEDBACK_REPORT_MARKER)
  );
  if (!attachment) {
    return null;
  }
  const metadata = feedbackReportMetadataSchema.safeParse(attachment.metadata);
  return metadata.success ? metadata.data : null;
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

// Linear's workflow state types, in the order a board shows them. A type
// Linear adds later sorts after these.
const LINEAR_STATE_TYPE_ORDER = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
] as const;

export interface FeedbackStateRef {
  color: string;
  id: string;
  name: string;
  position: number;
  type: string;
}

export interface FeedbackSummary {
  createdAt: string;
  id: string;
  kind: FeedbackKind;
  state: FeedbackStateRef;
  status: FeedbackStatus;
}

export interface FeedbackCounts {
  closed: number;
  declined: number;
  open: number;
  resolved: number;
}

export interface FeedbackStateGroup {
  color: string;
  count: number;
  name: string;
  stateId: string;
  type: string;
}

function matchesListStatus(
  status: FeedbackStatus,
  filter: FeedbackListStatus | undefined
): boolean {
  if (!filter || filter === "open") {
    return filter === undefined || status === "open";
  }
  if (filter === "closed") {
    return status !== "open";
  }
  return status === filter;
}

function typeRank(type: string): number {
  const index = LINEAR_STATE_TYPE_ORDER.indexOf(
    type as (typeof LINEAR_STATE_TYPE_ORDER)[number]
  );
  return index === -1 ? LINEAR_STATE_TYPE_ORDER.length : index;
}

// Status type, then the team's own order for that type, then newest first.
// Two states can share a type and position (for example after the saved team
// changes), so the state id keeps each state's rows together.
function compareSummaries(
  left: FeedbackSummary,
  right: FeedbackSummary
): number {
  const byType = typeRank(left.state.type) - typeRank(right.state.type);
  if (byType !== 0) {
    return byType;
  }
  const byPosition = left.state.position - right.state.position;
  if (byPosition !== 0) {
    return byPosition;
  }
  const byState = left.state.id.localeCompare(right.state.id);
  if (byState !== 0) {
    return byState;
  }
  const byCreated = right.createdAt.localeCompare(left.createdAt);
  if (byCreated !== 0) {
    return byCreated;
  }
  return left.id.localeCompare(right.id);
}

export function pageFeedbackSummaries(
  items: FeedbackSummary[],
  input: {
    kind?: FeedbackKind;
    limit: number;
    offset: number;
    status?: FeedbackListStatus;
  }
): {
  counts: FeedbackCounts;
  groups: FeedbackStateGroup[];
  ids: string[];
  total: number;
} {
  const counts: FeedbackCounts = {
    open: 0,
    closed: 0,
    resolved: 0,
    declined: 0,
  };
  for (const item of items) {
    counts[item.status] += 1;
    if (item.status !== "open") {
      counts.closed += 1;
    }
  }

  const filtered = items
    .filter((item) => matchesListStatus(item.status, input.status))
    .filter((item) => (input.kind ? item.kind === input.kind : true))
    .sort(compareSummaries);

  const groups: FeedbackStateGroup[] = [];
  const groupIndex = new Map<string, number>();
  for (const item of filtered) {
    const existing = groupIndex.get(item.state.id);
    if (existing === undefined) {
      groupIndex.set(item.state.id, groups.length);
      groups.push({
        stateId: item.state.id,
        name: item.state.name,
        color: item.state.color,
        type: item.state.type,
        count: 1,
      });
    } else {
      const group = groups[existing];
      if (group) {
        group.count += 1;
      }
    }
  }

  return {
    counts,
    groups,
    total: filtered.length,
    ids: filtered
      .slice(input.offset, input.offset + input.limit)
      .map((item) => item.id),
  };
}
