"use client";

import { History, Loader2, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { type MouseEvent, useState, useTransition } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { EmptyState } from "@/components/empty-state";
import { ActorLabel } from "@/components/token-actor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ConfigRevision } from "@/lib/api/watcher-config/revisions";
import {
  describeSettingsChanges,
  settingsEqual,
} from "@/lib/api/watcher-config/settings";
import { ChangeList, ConfigRevisionStatusBadge } from "./watcher-config-status";

/**
 * The watcher's config changes, newest first. Admins can restore an older
 * revision, which saves its settings as a new change.
 */
export function WatcherConfigHistory({
  watcherId,
  revisions,
  canRestore,
}: {
  watcherId: string;
  revisions: ConfigRevision[];
  canRestore: boolean;
}) {
  const [restoring, setRestoring] = useState<ConfigRevision | null>(null);

  if (revisions.length === 0) {
    return (
      <EmptyState icon={History} size="compact">
        No config changes recorded yet. The history starts the next time the
        watcher reports its config or an admin saves a change.
      </EmptyState>
    );
  }

  const latest = revisions[0];

  return (
    <>
      <ol className="flex flex-col divide-y rounded-lg border bg-background dark:bg-muted">
        {revisions.map((rev, index) => {
          const previous = revisions[index + 1];
          const changes = previous
            ? describeSettingsChanges(previous.settings, rev.settings)
            : [];
          const restorable =
            canRestore &&
            rev.revision !== latest.revision &&
            !settingsEqual(rev.settings, latest.settings);
          return (
            <li className="flex flex-col gap-2 p-3 text-sm" key={rev.revision}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">Revision {rev.revision}</span>
                <Badge variant="secondary">
                  {rev.source === "web" ? "Data Hub" : "Instrument PC"}
                </Badge>
                <ConfigRevisionStatusBadge status={rev.status} />
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  {rev.createdBy ? (
                    <>
                      <ActorLabel actor={rev.createdBy} />
                      <span>·</span>
                    </>
                  ) : null}
                  <RelativeTime date={rev.createdAt.toISOString()} />
                </span>
                {restorable ? (
                  <Button
                    className="ml-auto"
                    onClick={() => setRestoring(rev)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <RotateCcw data-icon="inline-start" />
                    Restore
                  </Button>
                ) : null}
              </div>
              {rev.statusReason ? (
                <p className="break-words text-muted-foreground text-xs">
                  {rev.statusReason}
                </p>
              ) : null}
              {previous ? (
                <ChangeList changes={changes} />
              ) : (
                <p className="text-muted-foreground text-xs">
                  {revisions.length < CONFIG_HISTORY_LIMIT_HINT
                    ? "First recorded settings."
                    : "Older revisions aren't shown."}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <RestoreDialog
        latestRevision={latest.revision}
        onOpenChange={(open) => {
          if (!open) {
            setRestoring(null);
          }
        }}
        revision={restoring}
        watcherId={watcherId}
      />
    </>
  );
}

// The page loads up to 50 revisions; at that length the oldest one shown
// isn't necessarily the first.
const CONFIG_HISTORY_LIMIT_HINT = 50;

function RestoreDialog({
  watcherId,
  latestRevision,
  revision,
  onOpenChange,
}: {
  watcherId: string;
  latestRevision: number;
  revision: ConfigRevision | null;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleRestore(e: MouseEvent) {
    e.preventDefault();
    if (!revision) {
      return;
    }
    startTransition(async () => {
      const res = await fetch(
        `/api/v1/watchers/${watcherId}/config-revisions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base_revision: latestRevision,
            settings: revision.settings,
          }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Couldn't restore the revision");
        if (body?.error?.details?.reason === "stale_revision") {
          router.refresh();
        }
        return;
      }
      toast.success(`Restoring revision ${revision.revision}`, {
        description: "The watcher applies it within about a minute.",
      });
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog onOpenChange={onOpenChange} open={revision !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Restore revision {revision?.revision}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This saves revision {revision?.revision}&apos;s settings as a new
            change. The watcher applies it within about a minute of its next
            check-in.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={isPending} onClick={handleRestore}>
            {isPending ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : null}
            Restore
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
