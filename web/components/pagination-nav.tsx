"use client";

import { parseAsInteger, useQueryState } from "nuqs";
import type { MouseEvent } from "react";
import { useTablePending } from "@/components/table-pending";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { cn } from "@/lib/utils";

function getVisiblePages(
  page: number,
  totalPages: number
): (number | "ellipsis")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: (number | "ellipsis")[] = [1];

  if (page > 3) {
    pages.push("ellipsis");
  }

  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (page < totalPages - 2) {
    pages.push("ellipsis");
  }

  if (totalPages > 1) {
    pages.push(totalPages);
  }

  return pages;
}

export function PaginationNav({
  page,
  totalPages,
  pageParam,
}: {
  page: number;
  totalPages: number;
  pageParam: string;
}) {
  // When used inside a TablePendingProvider, URL updates are wrapped in a
  // React transition so the sibling table can render a "stale" treatment
  // until the new RSC payload streams in.
  const { isPending, isPendingVisible, startTransition } = useTablePending();
  const [, setPage] = useQueryState(
    pageParam,
    parseAsInteger
      .withDefault(1)
      .withOptions({ shallow: false, startTransition })
  );

  if (totalPages <= 1) {
    return null;
  }

  const visible = getVisiblePages(page, totalPages);

  function go(target: number) {
    return (e: MouseEvent) => {
      e.preventDefault();
      setPage(target === 1 ? null : target);
    };
  }

  const atPrev = page <= 1;
  const atNext = page >= totalPages;

  return (
    <Pagination
      aria-busy={isPending}
      className={cn(
        "py-3 transition-opacity duration-150",
        isPending && "pointer-events-none cursor-wait",
        isPendingVisible && "opacity-60"
      )}
    >
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            aria-disabled={atPrev}
            className={atPrev ? "pointer-events-none opacity-50" : undefined}
            href="#"
            onClick={go(page - 1)}
          />
        </PaginationItem>

        {visible.map((p, i) =>
          p === "ellipsis" ? (
            <PaginationItem
              key={`ellipsis-${String(visible[i - 1])}-${String(visible[i + 1])}`}
            >
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={p}>
              <PaginationLink href="#" isActive={p === page} onClick={go(p)}>
                {p}
              </PaginationLink>
            </PaginationItem>
          )
        )}

        <PaginationItem>
          <PaginationNext
            aria-disabled={atNext}
            className={atNext ? "pointer-events-none opacity-50" : undefined}
            href="#"
            onClick={go(page + 1)}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
