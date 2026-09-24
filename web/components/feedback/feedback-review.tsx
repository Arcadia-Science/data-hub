"use client";

import type { ReactNode } from "react";
import { FeedbackStatusFilter } from "@/components/feedback/feedback-status-filter";
import {
  TablePendingBoundary,
  TablePendingProvider,
  useTablePending,
} from "@/components/table-pending";
import type { FeedbackStatus } from "@/lib/api/feedback-schema";

export function FeedbackReview({
  children,
  counts,
}: {
  children: ReactNode;
  counts: Record<FeedbackStatus, number>;
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
  counts: Record<FeedbackStatus, number>;
}) {
  const { startTransition } = useTablePending();
  return (
    <div className="grid gap-4">
      <FeedbackStatusFilter counts={counts} startTransition={startTransition} />
      <TablePendingBoundary>{children}</TablePendingBoundary>
    </div>
  );
}
