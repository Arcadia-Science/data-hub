"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * The floating card that a table shows while rows are selected: pinned to the
 * bottom of the window, the count of what is selected on the left, and on the
 * right the actions (`children`) followed by Clear. The runs table and the run
 * page's files table both render through it, so they look and behave alike.
 *
 * It is floating, and not a strip above the table, so the table doesn't jump
 * down when the first row is selected. Which actions to offer, and the dialogs
 * they open, belong to the caller. Render the dialogs beside the shell, not
 * inside it.
 *
 * `noun` is the singular name of what is selected, such as "run" or "deleted
 * file". The count line adds the "s" for anything but one.
 */
export function BulkActionBarShell({
  ariaLabel,
  children,
  count,
  noun,
  onClear,
  pending,
}: {
  ariaLabel: string;
  // The action buttons, in the order they should appear.
  children: ReactNode;
  count: number;
  noun: string;
  onClear: () => void;
  // Whether an action is running. Clear waits for it.
  pending: boolean;
}) {
  const { state: sidebarState, isMobile } = useSidebar();

  // On desktop the expanded sidebar reserves space on the left, so anchor the
  // bar's left edge to the sidebar's right edge so it spans the full main
  // panel width. On mobile the sidebar is an overlay sheet, so the main panel
  // already spans the full viewport.
  const offsetForSidebar = !isMobile && sidebarState === "expanded";

  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "fade-in slide-in-from-bottom-4 fixed right-0 bottom-6 z-50 mx-auto flex max-w-6xl animate-in flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border bg-popover px-8 py-2.5 text-popover-foreground shadow-2xl transition-[left] duration-200 ease-linear",
        offsetForSidebar ? "left-[var(--sidebar-width)]" : "left-0"
      )}
      role="region"
    >
      <div className="text-sm">
        <span className="font-medium">{count}</span>{" "}
        <span className="text-muted-foreground">
          {count === 1 ? noun : `${noun}s`} selected
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {children}
        <Button
          disabled={pending}
          onClick={onClear}
          size="sm"
          type="button"
          variant="ghost"
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
