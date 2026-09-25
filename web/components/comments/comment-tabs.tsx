"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import type { ReactNode } from "react";
import { Tabs } from "@/components/ui/tabs";

export function CommentTabs<const T extends string>({
  children,
  defaultValue,
  values,
}: {
  children: ReactNode;
  defaultValue: T;
  values: readonly T[];
}) {
  const [tab, setTab] = useQueryState(
    "comments",
    parseAsStringLiteral(values).withDefault(defaultValue).withOptions({
      clearOnDefault: true,
      shallow: true,
    })
  );

  return (
    <Tabs onValueChange={(value) => setTab(value as T)} value={tab}>
      {children}
    </Tabs>
  );
}
