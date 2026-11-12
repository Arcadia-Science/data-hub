"use client";

import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WatcherConfigForm } from "@/components/watchers/watcher-config-form";
import {
  ConfigChangeCallout,
  RestartPendingCallout,
  UnreadableConfigCallout,
} from "@/components/watchers/watcher-config-status";
import type { WatcherConfigState } from "@/lib/api/watcher-config/revisions";

/**
 * The instrument page's "Edit watcher config" dialog. Shares the form with
 * the watcher's Configuration tab, which also has the history.
 */
export function EditWatcherConfigDialog({
  watcherId,
  hostname,
  watcherOnline,
  state,
  open,
  onOpenChange,
}: {
  watcherId: string;
  hostname: string | null;
  watcherOnline: boolean;
  state: WatcherConfigState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit watcher config</DialogTitle>
          <DialogDescription>
            Changes reach the watcher{hostname ? ` on ${hostname}` : ""} within
            about a minute. See every change on the{" "}
            <Link
              className="underline underline-offset-2"
              href={`/watchers/${watcherId}?tab=configuration`}
            >
              watcher&apos;s Configuration tab
            </Link>
            .
          </DialogDescription>
        </DialogHeader>
        <UnreadableConfigCallout
          hasSettings={state.baseSettings !== null}
          problem={state.reportedProblem}
        />
        <ConfigChangeCallout
          current={state.running?.settings ?? null}
          latest={state.latest}
          watcherOnline={watcherOnline}
        />
        <RestartPendingCallout
          revision={state.restartPending}
          running={state.running}
        />
        {state.baseSettings ? (
          <WatcherConfigForm
            baseRevision={state.configRevision}
            editable={state.editable}
            initialSettings={state.baseSettings}
            key={state.configRevision ?? "none"}
            onSaved={() => onOpenChange(false)}
            savedSettings={state.savedSettings}
            watcherId={watcherId}
            watcherVersion={state.watcherVersion}
          />
        ) : state.reportedProblem ? null : (
          <p className="text-muted-foreground text-sm">
            The watcher hasn&apos;t reported its config yet, so there&apos;s
            nothing to edit.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
