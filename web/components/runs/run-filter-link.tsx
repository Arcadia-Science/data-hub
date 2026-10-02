"use client";

import Link from "next/link";
import { createContext, type ReactNode, use } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RunMetadataFilterParam } from "@/lib/api/run-metadata-filters";

interface RunFilterLinkContextValue {
  actions: {
    hrefFor: (param: RunMetadataFilterParam, value: string) => string;
  };
}

const RunFilterLinkContext = createContext<RunFilterLinkContextValue | null>(
  null
);

export function RunFilterLinkProvider({
  children,
  instrumentId,
}: {
  children: ReactNode;
  instrumentId: string;
}) {
  const hrefFor = (param: RunMetadataFilterParam, value: string) =>
    `/instruments/${encodeURIComponent(instrumentId)}?${new URLSearchParams({ [param]: value })}`;

  return (
    <RunFilterLinkContext value={{ actions: { hrefFor } }}>
      {children}
    </RunFilterLinkContext>
  );
}

/**
 * Links a metadata badge to the instrument's runs table filtered to `value`.
 * `value` must match the runs-table filter encoding for `param`, which is
 * not always the badge's display text (e.g. Aunty temperature is `start|end`).
 */
export function RunFilterLink({
  children,
  param,
  value,
}: {
  children: ReactNode;
  param: RunMetadataFilterParam;
  value: string;
}) {
  const context = use(RunFilterLinkContext);
  if (!context) {
    return children;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          className="inline-flex rounded-4xl outline-none transition-opacity hover:opacity-75 focus-visible:ring-2 focus-visible:ring-ring"
          href={context.actions.hrefFor(param, value)}
        >
          {children}
        </Link>
      </TooltipTrigger>
      <TooltipContent>Show matching runs</TooltipContent>
    </Tooltip>
  );
}
