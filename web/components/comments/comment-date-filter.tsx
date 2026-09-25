"use client";

import { useQueryStates } from "nuqs";
import { RunsDateFilter } from "@/components/runs/runs-date-filter";
import { dashboardSearchParams } from "@/lib/search-params";

export function CommentDateFilter() {
  const [filters, setFilters] = useQueryStates(dashboardSearchParams, {
    shallow: false,
  });

  return (
    <RunsDateFilter
      align="end"
      defaultPreset="today"
      onChange={(range) =>
        setFilters({
          comments_from: range.from,
          comments_to: range.to,
        })
      }
      value={{ from: filters.comments_from, to: filters.comments_to }}
    />
  );
}
