import { Badge } from "@/components/ui/badge";
import type { RunDetail } from "@/lib/api/instrument-runs";
import { ArrowLeft, Trash2 } from "lucide-react";
import Link from "next/link";

const sourceBadge: Record<
  "lambda" | "watcher",
  { label: string; variant: "default" | "outline" | "secondary" }
> = {
  lambda: { label: "Lambda", variant: "secondary" },
  watcher: { label: "Watcher", variant: "outline" },
};

function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function RunHeader({
  run,
  children,
}: {
  run: RunDetail;
  children?: React.ReactNode;
}) {
  const sb = sourceBadge[run.source];

  return (
    <div className="flex flex-col gap-4">
      <Link
        href={`/instruments/${run.instrumentId}`}
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {run.instrumentDisplayName}
      </Link>

      {run.deletedAt && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
          <Trash2 className="size-4 shrink-0" />
          <span>
            Deleted {formatTimestamp(run.deletedAt)}
            {run.filesPurgedAt && (
              <> &middot; Files purged {formatTimestamp(run.filesPurgedAt)}</>
            )}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            {run.runId}
          </h1>
          <Badge variant={sb.variant} className="text-[10px]">
            {sb.label}
          </Badge>
        </div>

        <div className="flex items-center gap-2">{children}</div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Created {formatTimestamp(run.createdAt)}</span>
        <span className="text-muted-foreground/40">&middot;</span>
        <span>Updated {formatTimestamp(run.updatedAt)}</span>
        {run.watcherId && (
          <>
            <span className="text-muted-foreground/40">&middot;</span>
            <span className="font-mono">{run.watcherId}</span>
          </>
        )}
      </div>
    </div>
  );
}
