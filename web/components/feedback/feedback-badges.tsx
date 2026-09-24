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

const KIND_CLASS: Record<FeedbackKind, string> = {
  bug: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  feature_request:
    "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  other: "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300",
};

const STATUS_CLASS: Record<FeedbackStatus, string> = {
  open: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  resolved: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  declined: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

export function FeedbackKindBadge({ kind }: { kind: FeedbackKind }) {
  return <Badge className={KIND_CLASS[kind]}>{KIND_LABELS[kind]}</Badge>;
}

export function FeedbackStatusBadge({ status }: { status: FeedbackStatus }) {
  return (
    <Badge className={STATUS_CLASS[status]}>{STATUS_LABELS[status]}</Badge>
  );
}

export function feedbackKindLabel(kind: FeedbackKind): string {
  return KIND_LABELS[kind];
}

export function feedbackStatusLabel(status: FeedbackStatus): string {
  return STATUS_LABELS[status];
}
