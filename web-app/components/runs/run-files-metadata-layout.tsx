import type { ReactNode } from "react";

/**
 * Stacked layout for run detail: Instrument Metadata (collapsed strip) above
 * Files (full width). Pass children in order: Metadata, then Files.
 */
export function RunFilesMetadataLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-4">{children}</div>;
}
