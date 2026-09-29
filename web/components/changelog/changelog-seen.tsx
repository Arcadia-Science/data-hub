"use client";

import { createContext, type ReactNode, use, useEffect, useState } from "react";
import {
  listUnseen,
  readChangelogSeenIds,
  useChangelogSeen,
} from "@/hooks/use-changelog-seen";
import { dataHubMarkBlueClassName } from "@/lib/changelog/copy";
import { cn } from "@/lib/utils";

interface ChangelogSeenContextValue {
  state: {
    // Null until localStorage has been read, so the first paint doesn't
    // claim every entry is new and then take the badges away.
    unseenIds: ReadonlySet<string> | null;
  };
}

const ChangelogSeenContext = createContext<ChangelogSeenContextValue | null>(
  null
);

// Kept for this visit. Opening the changelog writes the ids to localStorage
// immediately, and React Strict Mode runs that effect twice. The second pass
// would otherwise read the just-written ids and hide every New badge.
let unseenThisLoad: { key: string; ids: ReadonlySet<string> } | null = null;

function unseenForVisit(ids: readonly string[]): ReadonlySet<string> {
  const key = ids.join("\n");
  if (unseenThisLoad?.key === key) {
    return unseenThisLoad.ids;
  }
  const unseen = new Set(listUnseen(ids, readChangelogSeenIds()));
  unseenThisLoad = { key, ids: unseen };
  return unseen;
}

function useChangelogSeenState(): ChangelogSeenContextValue {
  const value = use(ChangelogSeenContext);
  if (!value) {
    throw new Error(
      "Changelog pieces must render inside ChangelogSeenProvider"
    );
  }
  return value;
}

export function ChangelogSeenProvider({
  children,
  ids,
}: {
  children: ReactNode;
  ids: readonly string[];
}) {
  const { markSeen } = useChangelogSeen();
  const [unseenIds, setUnseenIds] = useState<ReadonlySet<string> | null>(null);
  const idKey = ids.join("\n");

  useEffect(() => {
    const list = idKey.length === 0 ? [] : idKey.split("\n");
    setUnseenIds(unseenForVisit(list));
    markSeen(list);
  }, [idKey, markSeen]);

  return (
    <ChangelogSeenContext value={{ state: { unseenIds } }}>
      {children}
    </ChangelogSeenContext>
  );
}

export function ChangelogNewBadge({ id }: { id: string }) {
  const {
    state: { unseenIds },
  } = useChangelogSeenState();

  if (!unseenIds?.has(id)) {
    return null;
  }

  return (
    <span
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center rounded-md px-2 font-semibold text-[13px] text-white",
        dataHubMarkBlueClassName
      )}
    >
      New
    </span>
  );
}
