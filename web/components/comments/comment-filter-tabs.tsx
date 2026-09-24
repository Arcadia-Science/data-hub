"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { tabsListVariants } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

function FilterLink({
  children,
  current,
  href,
}: {
  children: string;
  current: boolean;
  href: string;
}) {
  return (
    <Link
      aria-current={current ? "page" : undefined}
      className={cn(
        "inline-flex h-[calc(100%-1px)] items-center justify-center rounded-md px-2 py-1 font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        current
          ? "bg-background text-foreground shadow-sm"
          : "text-foreground/60 hover:text-foreground"
      )}
      href={href}
    >
      {children}
    </Link>
  );
}

export function CommentFilterTabs({
  active,
  currentUserId,
}: {
  active: "all" | "mine" | null;
  currentUserId: string;
}) {
  return (
    <nav aria-label="Comment filters" className={tabsListVariants()}>
      <FilterLink current={active === "all"} href="/comments">
        All
      </FilterLink>
      <FilterLink
        current={active === "mine"}
        href={`/comments?ran_by=${encodeURIComponent(currentUserId)}`}
      >
        On my runs
      </FilterLink>
    </nav>
  );
}

export function CommentPersonFilter({ label }: { label: string }) {
  return (
    <Link
      aria-label={`Remove filter: ${label}`}
      className="inline-flex w-fit items-center gap-1.5 rounded-md bg-muted px-2 py-1 font-medium text-foreground text-sm transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href="/comments"
    >
      {label}
      <X aria-hidden="true" className="size-3.5" />
    </Link>
  );
}
