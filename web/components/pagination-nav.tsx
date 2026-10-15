"use client";

import { usePathname, useSearchParams } from "next/navigation";
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
import { buildPageHref } from "@/lib/pagination";
import { isPlainLeftClick } from "@/lib/plain-click";
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, setPage] = useQueryState(
    pageParam,
    parseAsInteger
      .withDefault(1)
      .withOptions({ shallow: false, history: "push", startTransition })
  );

  if (totalPages <= 1) {
    return null;
  }

  const visible = getVisiblePages(page, totalPages);

  const hrefFor = (target: number) =>
    buildPageHref(pathname, searchParams, pageParam, target);

  // Only plain left clicks update the URL in place (inside the table's
  // transition). Cmd/Ctrl/middle clicks fall through to the real `href` so the
  // browser can open that page in a new tab.
  function go(target: number) {
    return (e: MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainLeftClick(e)) {
        return;
      }
      e.preventDefault();
      setPage(target === 1 ? null : target);
    };
  }

  const atPrev = page <= 1;
  const atNext = page >= totalPages;

  // At either end the arrow has no `href`, so it is not a link: it leaves the
  // tab order and Enter does nothing. `aria-disabled` keeps it announced.
  const disabledArrow = {
    "aria-disabled": true,
    className: "pointer-events-none opacity-50",
    role: "link",
  } as const;

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
          {atPrev ? (
            <PaginationPrevious {...disabledArrow} />
          ) : (
            <PaginationPrevious
              href={hrefFor(page - 1)}
              onClick={go(page - 1)}
            />
          )}
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
              <PaginationLink
                href={hrefFor(p)}
                isActive={p === page}
                onClick={go(p)}
              >
                {p}
              </PaginationLink>
            </PaginationItem>
          )
        )}

        <PaginationItem>
          {atNext ? (
            <PaginationNext {...disabledArrow} />
          ) : (
            <PaginationNext href={hrefFor(page + 1)} onClick={go(page + 1)} />
          )}
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
