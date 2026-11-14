"use client";

import Link from "next/link";
import { tabsListVariants } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export interface LinkTab {
  href: string;
  key: string;
  label: string;
}

/**
 * Tabs that are links to pages, styled like `<TabsList variant="line">`. Use
 * them when each tab is its own route: they keep the browser's back button,
 * deep links and prefetching, and the server renders only the open tab. The
 * current tab carries `aria-current="page"`, which is what screen readers
 * announce. The caller builds each `href`, so it decides which query
 * parameters carry over from one tab to the next.
 */
export function LinkTabs({
  tabs,
  current,
  label,
  className,
}: {
  tabs: readonly LinkTab[];
  /** The `key` of the open tab. */
  current: string;
  /** Names the navigation landmark, such as "Watcher sections". */
  label: string;
  className?: string;
}) {
  return (
    // `group/tabs` and `data-orientation` are what `tabsListVariants` styles by.
    <nav
      aria-label={label}
      className={cn("group/tabs flex", className)}
      data-orientation="horizontal"
    >
      <ul
        className={cn(tabsListVariants({ variant: "line" }), "list-none")}
        data-variant="line"
      >
        {tabs.map((tab) => {
          const isCurrent = tab.key === current;
          return (
            <li className="flex h-full" key={tab.key}>
              <Link
                aria-current={isCurrent ? "page" : undefined}
                className={cn(
                  "relative inline-flex h-[calc(100%-1px)] items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2 py-1 font-medium text-foreground/60 text-sm transition-all hover:text-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:text-muted-foreground dark:hover:text-foreground",
                  "after:absolute after:inset-x-0 after:bottom-[-5px] after:h-0.5 after:bg-foreground after:opacity-0 after:transition-opacity",
                  "aria-[current=page]:text-foreground aria-[current=page]:after:opacity-100 dark:aria-[current=page]:text-foreground"
                )}
                href={tab.href}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
