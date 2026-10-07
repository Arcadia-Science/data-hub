import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_LABELS,
  type FeedbackKind,
  type FeedbackStatus,
} from "@/lib/api/feedback-schema";

const KIND_CLASS: Record<FeedbackKind, string> = {
  bug: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  feature_request:
    "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  other: "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300",
};

const STATUS_CLASS: Record<FeedbackStatus, string> = {
  open: "border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200",
  resolved:
    "border-green-200 bg-green-100 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200",
  declined:
    "border-zinc-200 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
};

const STATUS_DOT: Record<FeedbackStatus, string> = {
  open: "bg-blue-600",
  resolved: "bg-green-600",
  declined: "bg-zinc-500",
};

export function FeedbackKindBadge({ kind }: { kind: FeedbackKind }) {
  return (
    <Badge className={KIND_CLASS[kind]}>{FEEDBACK_KIND_LABELS[kind]}</Badge>
  );
}

export function FeedbackStatusBadge({ status }: { status: FeedbackStatus }) {
  return (
    <span
      className={`inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 font-medium text-[13px] ${STATUS_CLASS[status]}`}
    >
      <span
        aria-hidden="true"
        className={`size-[7px] rounded-full ${STATUS_DOT[status]}`}
      />
      {FEEDBACK_STATUS_LABELS[status]}
    </span>
  );
}

export function feedbackStatusLabel(status: FeedbackStatus): string {
  return FEEDBACK_STATUS_LABELS[status];
}

const PRIORITY_CLASS: Record<number, string> = {
  1: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  2: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  3: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  4: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

// `empty` is what shows when Linear has no priority for the report. The
// table passes a dash to keep the column quiet; the sheet spells it out.
export function FeedbackPriority({
  empty = <span className="text-muted-foreground">No priority</span>,
  label,
  priority,
}: {
  empty?: ReactNode;
  label: string | null;
  priority: number | null;
}) {
  if (priority == null || priority === 0 || !label || label === "No priority") {
    return empty;
  }
  return (
    <Badge className={PRIORITY_CLASS[priority] ?? PRIORITY_CLASS[3]}>
      {label}
    </Badge>
  );
}

export function FeedbackLabelChip({
  color,
  name,
}: {
  color: string;
  name: string;
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 font-medium text-xs"
      title={name}
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}
