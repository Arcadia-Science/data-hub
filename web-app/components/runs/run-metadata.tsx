import type { ReactNode } from "react";

export function RunMetadata({
  children,
}: {
  metadata: Record<string, unknown>;
  children?: ReactNode;
}) {
  if (!children) {
    return (
      <div className="flex items-center rounded-lg border px-4 py-3">
        <div>
          <p className="text-sm font-semibold">Instrument metadata</p>
          <p className="text-xs text-muted-foreground">
            No metadata recorded yet
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <div className="px-4 py-3">
        <p className="text-sm font-semibold">Instrument metadata</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t px-4 py-3">
        {children}
      </div>
    </div>
  );
}
