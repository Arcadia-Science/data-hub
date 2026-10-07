"use client";

import { useQueryStates } from "nuqs";
import type { TransitionStartFunction } from "react";
import { Button } from "@/components/ui/button";
import type { FeedbackCounts } from "@/lib/linear/feedback-link";
import type { FeedbackTab } from "@/lib/search-params";
import { feedbackSearchParams } from "@/lib/search-params";

const TABS: { label: string; value: FeedbackTab }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
];

export function FeedbackStatusFilter({
  counts,
  startTransition,
}: {
  counts: FeedbackCounts;
  startTransition: TransitionStartFunction;
}) {
  const [filters, setFilters] = useQueryStates(feedbackSearchParams, {
    shallow: false,
    startTransition,
  });

  return (
    <div className="flex flex-wrap gap-2">
      {TABS.map((tab) => (
        <Button
          aria-pressed={filters.status === tab.value}
          key={tab.value}
          onClick={() =>
            setFilters({
              status: tab.value === "open" ? null : tab.value,
              page: null,
            })
          }
          size="sm"
          type="button"
          variant={filters.status === tab.value ? "default" : "outline"}
        >
          {tab.label}
          <span className="tabular-nums">{counts[tab.value]}</span>
        </Button>
      ))}
    </div>
  );
}
