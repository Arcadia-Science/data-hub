"use client";

import type { ReactNode } from "react";
import { FeedbackStatusFilter } from "@/components/feedback/feedback-status-filter";
import {
  TablePendingBoundary,
  TablePendingProvider,
  useTablePending,
} from "@/components/table-pending";
import type { FeedbackCounts } from "@/lib/linear/feedback-link";

export function FeedbackReview({
  children,
  counts,
}: {
  children: ReactNode;
  counts: FeedbackCounts;
}) {
  return (
    <TablePendingProvider>
      <FeedbackReviewLayout counts={counts}>{children}</FeedbackReviewLayout>
    </TablePendingProvider>
  );
}

function FeedbackReviewLayout({
  children,
  counts,
}: {
  children: ReactNode;
  counts: FeedbackCounts;
}) {
  const { startTransition } = useTablePending();
  return (
    <div className="grid gap-4">
      <FeedbackStatusFilter counts={counts} startTransition={startTransition} />
      <TablePendingBoundary>{children}</TablePendingBoundary>
    </div>
  );
}
