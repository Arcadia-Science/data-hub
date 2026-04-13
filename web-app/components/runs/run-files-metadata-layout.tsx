import type { ReactNode } from "react";

/**
 * Responsive row for run detail: Files (left) and Instrument Metadata (right) on large
 * screens; stacked column with metadata above files on smaller screens
 * (`flex-col-reverse`). Pass children in order: Files, then Metadata.
 */
export function RunFilesMetadataLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col-reverse gap-6 *:min-w-0 lg:flex-row lg:items-stretch lg:gap-6 lg:*:flex-1">
      {children}
    </div>
  );
}
