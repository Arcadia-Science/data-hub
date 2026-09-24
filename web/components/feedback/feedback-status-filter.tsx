"use client";

import { useQueryStates } from "nuqs";
import { Button } from "@/components/ui/button";
import type { FeedbackStatus } from "@/lib/api/feedback-schema";
import { feedbackSearchParams } from "@/lib/search-params";
import { feedbackStatusLabel } from "./feedback-badges";

const STATUSES: FeedbackStatus[] = ["open", "resolved", "declined"];

export function FeedbackStatusFilter({
  counts,
}: {
  counts: Record<FeedbackStatus, number>;
}) {
  const [filters, setFilters] = useQueryStates(feedbackSearchParams, {
    shallow: false,
  });

  return (
    <div className="flex flex-wrap gap-2">
      {STATUSES.map((status) => (
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
