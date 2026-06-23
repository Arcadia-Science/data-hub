import type { ReactNode } from "react";

export function RunMetadata({ children }: { children?: ReactNode }) {
  if (!children) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-semibold text-sm">Metadata</h2>
      <div className="rounded-lg border bg-background dark:bg-muted">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
          {children}
        </div>
      </div>
    </div>
  );
}
