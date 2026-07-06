"use client";

import { SearchIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

// `GlobalSearch` pulls in cmdk plus the result-row/highlight components, none
// of which are needed until the palette is actually opened. This trigger is
// mounted on every authenticated page (root layout header), so keeping it out
// of the initial bundle matters more than it would for a one-off dialog.
const GlobalSearch = dynamic(
  () => import("@/components/search/global-search").then((m) => m.GlobalSearch),
  { ssr: false }
);

// Warms the module cache so opening the palette (click or ⌘K) feels instant
// once the user has shown intent by hovering/focusing the trigger.
function preloadGlobalSearch() {
  import("@/components/search/global-search");
}

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
      <Button
        aria-label="Search runs, files, or instruments"
        className="justify-start gap-2 font-normal text-muted-foreground sm:w-64 dark:bg-muted/40"
        onClick={() => setOpen(true)}
        onFocus={preloadGlobalSearch}
        onMouseEnter={preloadGlobalSearch}
        size="sm"
        type="button"
        variant="outline"
      >
        <SearchIcon />
        <span className="hidden truncate sm:inline">Search…</span>
        {shortcutHint ? (
          <kbd className="ml-auto hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] sm:inline">
            {shortcutHint}
          </kbd>
        ) : null}
      </Button>
      <GlobalSearch onOpenChange={setOpen} open={open} />
    </>
  );
}
