"use client";

import { useQueryStates } from "nuqs";
import type { TransitionStartFunction } from "react";
import { Button } from "@/components/ui/button";
import {
  type FeedbackStatus,
  feedbackStatusSchema,
} from "@/lib/api/feedback-schema";
import { feedbackSearchParams } from "@/lib/search-params";
import { feedbackStatusLabel } from "./feedback-badges";

export function FeedbackStatusFilter({
  counts,
  startTransition,
}: {
  counts: Record<FeedbackStatus, number>;
  startTransition: TransitionStartFunction;
}) {
  const [filters, setFilters] = useQueryStates(feedbackSearchParams, {
    shallow: false,
    startTransition,
  });

  return (
    <div className="flex flex-wrap gap-2">
      {feedbackStatusSchema.options.map((status) => (
        <Button
          aria-pressed={filters.status === status}
          key={status}
          onClick={() =>
            setFilters({
              status: status === "open" ? null : status,
              page: null,
            })
          }
          size="sm"
          type="button"
          variant={filters.status === status ? "default" : "outline"}
        >
          {feedbackStatusLabel(status)}
          <span className="tabular-nums">{counts[status]}</span>
        </Button>
      ))}
    </div>
  );
}
