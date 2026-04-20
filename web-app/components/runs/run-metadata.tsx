import type { ReactNode } from "react";

export function RunMetadata({
  children,
}: {
  metadata: Record<string, unknown>;
  children?: ReactNode;
}) {
  if (!children) {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Metadata</h2>
        <div className="flex items-center rounded-lg border px-4 py-3">
          <p className="text-xs text-muted-foreground">
            No metadata recorded yet
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Metadata</h2>
      <div className="rounded-lg border">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
          {children}
        </div>
      </div>
    </div>
  );
}
