import type { InstrumentType } from "@/lib/db/schema";

// Client-side notification row. The provider maps the GET /notifications
// wire shape onto this so grouping and the bell never see snake_case.

export interface NotificationActor {
  avatarUrl: string | null;
  displayName: string;
  id: string;
  initials: string;
}

export interface NotificationItem {
  actor: NotificationActor | null;
  // Caller-supplied message for `generic` and feedback rows; null otherwise.
  body: string | null;
  commentBody: string | null;
  commentId: string | null;
  createdAt: string;
  feedbackId: string | null;
  // Raw-file counts for run-anchored rows. Null on anchor-less `generic`.
  fileCount: number | null;
  filesFailed: number | null;
  id: string;
  instrumentDisplayName: string | null;
  instrumentId: string | null;
  instrumentType: InstrumentType | null;
  readAt: string | null;
  // Instrument-clock time when present; the run row prefers this over
  // `createdAt` for the time-of-day so backfilled runs show when they
  // actually ran, not when Data Hub learned about them.
  runAcquiredAt: string | null;
  runDisplayId: string | null;
  runId: string | null;
  type:
    | "run_created"
    | "comment_attributed"
    | "comment_participated"
    | "generic"
    | "feedback_submitted"
    | "feedback_updated";
}
