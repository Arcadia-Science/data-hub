"use client";

import { createContext, type ReactNode, use } from "react";

const RunSectionActionsContext = createContext<ReactNode>(null);

// The MCP View injects "Open in Data Hub" here so every instrument
// renderer gets the link without an extra prop.
export function RunSectionActionsProvider({
  actions,
  children,
}: {
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <RunSectionActionsContext.Provider value={actions}>
      {children}
    </RunSectionActionsContext.Provider>
  );
}

export function RunSectionHeading({
  actions,
  countLabel,
  title,
}: {
  actions?: ReactNode;
  countLabel?: string | number;
  title: string;
}) {
  const injected = use(RunSectionActionsContext);
  const resolved = actions ?? injected;
  const heading = (
    <h2 className="min-w-0 font-semibold text-sm">
      {countLabel == null ? title : `${title} (${countLabel})`}
    </h2>
  );
  if (!resolved) {
    return heading;
  }
  return (
    <div className="flex w-full min-w-0 items-center justify-between gap-3">
      {heading}
      <div className="shrink-0">{resolved}</div>
    </div>
  );
}
