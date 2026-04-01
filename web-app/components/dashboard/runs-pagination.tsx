"use client";

import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { parseAsInteger, useQueryState } from "nuqs";

type PaginationData = {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
};

export function RunsPagination({ pagination }: { pagination: PaginationData }) {
  const [page, setPage] = useQueryState(
    "page",
    parseAsInteger.withDefault(1).withOptions({ shallow: false })
  );

  if (pagination.total_pages <= 1) return null;

  const start = (pagination.page - 1) * pagination.per_page + 1;
  const end = Math.min(pagination.page * pagination.per_page, pagination.total);

  return (
    <div className="flex items-center justify-between">
      <p className="text-sm text-muted-foreground">
        {start}&ndash;{end} of {pagination.total} runs
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
          className="h-8 gap-1"
        >
          <ChevronLeft className="size-4" />
          Prev
        </Button>
        <span className="px-2 text-sm text-muted-foreground tabular-nums">
          {pagination.page} / {pagination.total_pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pagination.total_pages}
          onClick={() => setPage(page + 1)}
          className="h-8 gap-1"
        >
          Next
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
