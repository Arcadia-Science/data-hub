"use client";

import { useSyncExternalStore } from "react";
import { changelogDateHash } from "@/lib/changelog/copy";
import { cn } from "@/lib/utils";

function subscribeToHash(onStoreChange: () => void) {
  window.addEventListener("hashchange", onStoreChange);
  return () => window.removeEventListener("hashchange", onStoreChange);
}

function currentHash() {
  return window.location.hash;
}

function serverHash() {
  return "";
}

export function ChangelogJumpNav({
  dates,
}: {
  dates: readonly { date: string; label: string }[];
}) {
  const hash = useSyncExternalStore(subscribeToHash, currentHash, serverHash);

  if (dates.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label="Jump to date"
      className="flex flex-col gap-0.5 lg:sticky lg:top-6 lg:max-h-[calc(100svh-3rem)] lg:overflow-y-auto"
    >
      <div className="mb-1.5 font-semibold text-[13px] text-muted-foreground">
        Jump to date
      </div>
      {dates.map((item) => {
        const href = changelogDateHash(item.date);
        const current = hash === href;
        return (
          <a
            aria-current={current ? "location" : undefined}
            className={cn(
              "flex min-h-9 items-center rounded-md text-foreground text-sm no-underline hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              current && "font-medium"
            )}
            href={href}
            key={item.date}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
