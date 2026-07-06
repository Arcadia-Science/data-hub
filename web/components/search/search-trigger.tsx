"use client";

import { SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { GlobalSearch } from "@/components/search/global-search";

// Returns true when the keydown originated from an editable field, so a
// global ⌘K/Ctrl+K doesn't hijack a shortcut a text field might own.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function SearchTrigger() {
  const [open, setOpen] = useState(false);
  // Platform detection runs post-mount so the SSR'd markup (no hint) matches
  // the first client render, avoiding a hydration mismatch.
  const [shortcutHint, setShortcutHint] = useState("");

  useEffect(() => {
    const isMac = /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
    setShortcutHint(isMac ? "⌘K" : "Ctrl K");
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() !== "k" ||
        !(event.metaKey || event.ctrlKey)
      ) {
        return;
      }
      // When the palette is already open its own input handles keys; don't
      // treat that as an editable-field bail-out.
      if (!open && isEditableTarget(event.target)) {
        return;
      }
      event.preventDefault();
      setOpen((prev) => !prev);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <button
        aria-label="Search runs, files, or instruments"
        className="flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground sm:w-64 dark:bg-muted/40"
        onClick={() => setOpen(true)}
        type="button"
      >
        <SearchIcon className="size-4 shrink-0" />
        <span className="hidden truncate sm:inline">Search…</span>
        {shortcutHint ? (
          <kbd className="ml-auto hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] sm:inline">
            {shortcutHint}
          </kbd>
        ) : null}
      </button>
      <GlobalSearch onOpenChange={setOpen} open={open} />
    </>
  );
}
