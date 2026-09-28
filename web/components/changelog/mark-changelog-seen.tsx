"use client";

import { useEffect } from "react";
import { useChangelogSeen } from "@/hooks/use-changelog-seen";

export function MarkChangelogSeen({ ids }: { ids: readonly string[] }) {
  const { markSeen } = useChangelogSeen();
  const idKey = ids.join("\n");

  useEffect(() => {
    markSeen(idKey.length === 0 ? [] : idKey.split("\n"));
  }, [idKey, markSeen]);

  return null;
}
