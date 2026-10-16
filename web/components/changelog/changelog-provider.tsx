"use client";

import dynamic from "next/dynamic";
import { useQueryState } from "nuqs";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ChangelogDaySection } from "@/lib/changelog/group";
import { changelogSearchParams } from "@/lib/search-params";

// The window pulls in the markdown renderer, which most pages never need.
const ChangelogDialog = dynamic(
  () =>
    import("@/components/changelog/changelog-dialog").then(
      (module) => module.ChangelogDialog
    ),
  { ssr: false }
);

interface ChangelogContextValue {
  /** Every entry ID, newest first. */
  ids: readonly string[];
  /** Opens the window the way the account menu does, with no entry named. */
  open: () => void;
  preload: () => void;
}

const ChangelogContext = createContext<ChangelogContextValue | null>(null);

export function useChangelog(): ChangelogContextValue {
  const value = use(ChangelogContext);
  if (!value) {
    throw new Error("useChangelog must be used inside ChangelogProvider");
  }
  return value;
}

function preload() {
  import("@/components/changelog/changelog-dialog");
}

/**
 * Owns the changelog window for the whole signed-in shell, so a link with
 * `?changelog=<entry id>` can open it on any page. The sidebar can't hold it:
 * on a phone the sidebar only renders while it is open.
 */
export function ChangelogProvider({
  children,
  sections,
}: {
  children: ReactNode;
  sections: readonly ChangelogDaySection[];
}) {
  const ids = useMemo(
    () =>
      sections.flatMap((section) => section.entries.map((entry) => entry.id)),
    [sections]
  );
  const [entryParam, setEntryParam] = useQueryState(
    "changelog",
    changelogSearchParams.changelog
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  const linkedId =
    entryParam !== null && ids.includes(entryParam) ? entryParam : null;
  const open = menuOpen || linkedId !== null;

  // Stays mounted after the first open so the window can fade out.
  useEffect(() => {
    if (open) {
      setMounted(true);
    }
  }, [open]);

  // A link to an entry this deployment doesn't have, for example one from a
  // staging build that hasn't reached this site yet, opens the window as the
  // menu would.
  useEffect(() => {
    if (entryParam !== null && linkedId === null) {
      setMenuOpen(true);
      setEntryParam(null);
    }
  }, [entryParam, linkedId, setEntryParam]);

  const openFromMenu = useCallback(() => {
    setMounted(true);
    setMenuOpen(true);
  }, []);

  function handleOpenChange(next: boolean) {
    if (next) {
      setMenuOpen(true);
      return;
    }
    setMenuOpen(false);
    if (entryParam !== null) {
      setEntryParam(null);
    }
  }

  const value = useMemo(
    () => ({ ids, open: openFromMenu, preload }),
    [ids, openFromMenu]
  );

  return (
    <ChangelogContext value={value}>
      {children}
      {mounted ? (
        <ChangelogDialog
          ids={ids}
          linkedId={linkedId}
          onOpenChange={handleOpenChange}
          open={open}
          sections={sections}
        />
      ) : null}
    </ChangelogContext>
  );
}
