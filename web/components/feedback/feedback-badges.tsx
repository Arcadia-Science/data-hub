import { Badge } from "@/components/ui/badge";
import type { FeedbackKind, FeedbackStatus } from "@/lib/api/feedback-schema";

const KIND_LABELS: Record<FeedbackKind, string> = {
  bug: "Bug",
  feature_request: "Feature request",
  other: "Other",
};

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  declined: "Declined",
};

export function FeedbackKindBadge({ kind }: { kind: FeedbackKind }) {
  return <Badge variant="outline">{KIND_LABELS[kind]}</Badge>;
}

export function FeedbackStatusBadge({ status }: { status: FeedbackStatus }) {
  const variant =
    status === "resolved"
      ? "default"
      : status === "declined"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{STATUS_LABELS[status]}</Badge>;
}

export function feedbackKindLabel(kind: FeedbackKind): string {
  return KIND_LABELS[kind];
}

export function feedbackStatusLabel(status: FeedbackStatus): string {
  return STATUS_LABELS[status];
}
