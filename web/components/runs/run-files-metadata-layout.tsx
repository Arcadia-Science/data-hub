import type { ReactNode } from "react";

/**
 * Stacked layout for run detail: Instrument Metadata (collapsed strip), then
 * the lab notebooks, then Files (full width). Pass children in that order.
 */
export function RunFilesMetadataLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-4">{children}</div>;
}
