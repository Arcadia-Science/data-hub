"use client";

import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { parseAsInteger, useQueryState } from "nuqs";
import type { MouseEvent } from "react";

function getVisiblePages(
  page: number,
  totalPages: number
): (number | "ellipsis")[] {
  if (totalPages <= 7)
    return Array.from({ length: totalPages }, (_, i) => i + 1);

  const pages: (number | "ellipsis")[] = [1];

  if (page > 3) pages.push("ellipsis");

  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  for (let i = start; i <= end; i++) pages.push(i);

  if (page < totalPages - 2) pages.push("ellipsis");

  if (totalPages > 1) pages.push(totalPages);

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
  const [, setPage] = useQueryState(
    pageParam,
    parseAsInteger.withDefault(1).withOptions({ shallow: false })
  );

  if (totalPages <= 1) return null;

  const visible = getVisiblePages(page, totalPages);

  function go(target: number) {
    return (e: MouseEvent) => {
      e.preventDefault();
      setPage(target === 1 ? null : target);
      window.scrollTo({ top: 0, behavior: "instant" });
    };
  }

  return (
    <Pagination className="py-3">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href="#"
            onClick={go(page - 1)}
            aria-disabled={page <= 1}
            className={page <= 1 ? "pointer-events-none opacity-50" : undefined}
          />
        </PaginationItem>

        {visible.map((p, i) =>
          p === "ellipsis" ? (
            <PaginationItem key={`ellipsis-${i}`}>
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
            href="#"
            onClick={go(page + 1)}
            aria-disabled={page >= totalPages}
            className={
              page >= totalPages ? "pointer-events-none opacity-50" : undefined
            }
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
