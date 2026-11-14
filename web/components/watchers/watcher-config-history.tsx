"use client";

import { History, Loader2, Monitor, RotateCcw } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import type { ConfigRevision } from "@/lib/api/watcher-config/revisions";
import {
  describeSettingsChanges,
  settingsEqual,
  type WatcherConfigSettings,
} from "@/lib/api/watcher-config/settings";
import { ConfigRevisionStatusBadge } from "./watcher-config-status";

/** Who made a revision: a person, or the config file on the instrument PC. */
function RevisionAuthor({ revision }: { revision: ConfigRevision }) {
  if (revision.source === "pc") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Monitor aria-hidden="true" className="size-3.5" />
        From the instrument PC
      </span>
    );
  }
  if (revision.createdBy) {
    return (
      <ActorLabel
        actor={revision.createdBy}
        nameClassName="font-normal text-foreground"
      />
    );
  }
  return <span>Data Hub</span>;
}

/**
 * What a revision changed, as one line: "{setting}: {before} → {after}", with
 * one such pair for each setting that differs. The oldest revision has nothing
 * before it, so it says where its settings came from.
 */
function ChangeSummary({
  revision,
  previous,
  isOldestShown,
  allShown,
}: {
  revision: ConfigRevision;
  previous: ConfigRevision | undefined;
  isOldestShown: boolean;
  /** False when older revisions exist that the list doesn't load. */
  allShown: boolean;
}) {
  if (!previous) {
    if (isOldestShown && !allShown) {
      return (
        <p className="text-muted-foreground text-sm">
          Older revisions aren&apos;t shown.
        </p>
      );
    }
    return (
      <p className="text-sm">
        {revision.source === "pc"
          ? "Settings first reported by the watcher"
          : "First saved settings"}
      </p>
    );
  }
  const changes = describeSettingsChanges(previous.settings, revision.settings);
  if (changes.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Same settings as the revision before.
      </p>
    );
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {changes.map((change) => (
        <li className="min-w-0 break-words" key={change.key}>
          <span className="text-muted-foreground">{change.label}:</span>{" "}
          <span className="font-mono text-[13px]">{change.from}</span>
          <span aria-hidden="true"> → </span>
          <span className="sr-only"> to </span>
          <span className="font-mono text-[13px]">{change.to}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The watcher's config changes, newest first: each revision's number, state,
 * author, time and a one-line summary of what changed. Admins can restore a
 * past applied revision, which saves its settings as a new change.
 */
export function WatcherConfigHistory({
  watcherId,
  revisions,
  savedSettings,
  restartPendingRevision,
  canRestore,
}: {
  watcherId: string;
  revisions: ConfigRevision[];
  /** A PC edit the running watcher hasn't loaded yet, if any. */
  restartPendingRevision: number | null;
  /**
   * Restoring a revision with these settings would be refused as "No
   * changes", so it gets no button. Null after a rejection.
   */
  savedSettings: WatcherConfigSettings | null;
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
  const allShown = revisions.length < CONFIG_HISTORY_LIMIT_HINT;

  return (
    <>
      <ol className="flex flex-col divide-y">
        {revisions.map((rev, index) => {
          const previous = revisions[index + 1];
          // Only an applied revision can be restored, and not one whose
          // settings the server would refuse as no change.
          const restorable =
            canRestore &&
            rev.status === "applied" &&
            !(savedSettings && settingsEqual(rev.settings, savedSettings));
          return (
            <li
              className="flex flex-wrap items-start justify-between gap-3 py-3.5 first:pt-0 last:pb-0"
              key={rev.revision}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Revision {rev.revision}</span>
                  <ConfigRevisionStatusBadge status={rev.status} />
                </div>
                <div className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground">
                  <RevisionAuthor revision={rev} />
                  <span aria-hidden="true">·</span>
                  <RelativeTime date={rev.createdAt.toISOString()} />
                </div>
                {rev.statusReason ? (
                  <p className="break-words text-muted-foreground text-sm">
                    {rev.statusReason}
                  </p>
                ) : null}
                {rev.revision === restartPendingRevision ? (
                  <p className="text-muted-foreground text-sm">
                    Saved to the config file on the PC. Takes effect when the
                    watcher restarts.
                  </p>
                ) : null}
                <ChangeSummary
                  allShown={allShown}
                  isOldestShown={index === revisions.length - 1}
                  previous={previous}
                  revision={rev}
                />
              </div>
              {restorable ? (
                <Button
                  aria-label={`Restore revision ${rev.revision}`}
                  onClick={() => setRestoring(rev)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <RotateCcw data-icon="inline-start" />
                  Restore
                </Button>
              ) : null}
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
