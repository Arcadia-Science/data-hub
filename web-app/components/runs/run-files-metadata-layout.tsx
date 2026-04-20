import type { ReactNode } from "react";

/**
 * Stacked layout for run detail: Files (full width) above Instrument Metadata
 * (collapsed strip). Pass children in order: Files, then Metadata.
 */
export function RunFilesMetadataLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-4">{children}</div>;
}
