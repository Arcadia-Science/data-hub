import { FileText, Lock } from "lucide-react";
import { CodeBlock } from "@/components/code-block";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EditSettingsDialog } from "@/components/watchers/edit-settings-dialog";
import { SettingValue } from "@/components/watchers/setting-value";
import { WatcherConfigHistory } from "@/components/watchers/watcher-config-history";
import {
  ConfigStateNotice,
  UnreadableConfigCallout,
} from "@/components/watchers/watcher-config-status";
import { WatcherYamlDisclosure } from "@/components/watchers/watcher-yaml-disclosure";
import type {
  ConfigRevision,
  WatcherConfigState,
} from "@/lib/api/watcher-config/revisions";
import type { WatcherDetail } from "@/lib/api/watchers";
import { configNoticeKind } from "@/lib/watchers/config-notice";
import { currentSettingsRows } from "@/lib/watchers/current-settings";

/** The revision the one notice is about, or null when there is no notice. */
function noticeFor(state: WatcherConfigState) {
  const kind = configNoticeKind(
    state.latest?.status ?? null,
    state.restartPending !== null
  );
  const revision =
    kind === "edited_on_pc" ? state.restartPending : state.latest;
  return kind && revision ? { kind, revision } : null;
}

/**
 * The watcher's Settings tab: the one notice for the latest settings state,
 * what the watcher is running, the edit form (admins, current watcher only),
 * the change history, and the raw YAML. A member, or anyone looking at a past
 * watcher, gets no form and no Restore.
 */
export function WatcherConfig({
  watcher,
  state,
  history,
  isAdmin,
  viewerUserId,
  focusField,
}: {
  watcher: WatcherDetail;
  state: WatcherConfigState;
  history: ConfigRevision[];
  isAdmin: boolean;
  viewerUserId: string;
  /** Puts the cursor in this field of the edit form on load. */
  focusField?: "watch_directory";
}) {
  const running = state.running;
  const isPast = watcher.deletedAt !== null;
  const canEdit = isAdmin && !isPast;
  // A past watcher will never pick a change up or restart, so a notice about
  // one would mislead. Its history still shows every revision's state.
  const notice = isPast ? null : noticeFor(state);

  return (
    <div className="flex flex-col gap-5">
      <UnreadableConfigCallout
        hasSettings={state.baseSettings !== null}
        problem={state.reportedProblem}
      />
      {notice ? (
        <ConfigStateNotice
          kind={notice.kind}
          revision={notice.revision}
          viewerUserId={viewerUserId}
        />
      ) : null}

      {isAdmin ? null : (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Lock aria-hidden="true" className="size-4 shrink-0" />
          Only admins can change watcher settings.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Current settings</CardTitle>
          <CardDescription>
            What the watcher is running now, as it last reported.
          </CardDescription>
          {canEdit && state.baseSettings ? (
            <CardAction>
              <EditSettingsDialog
                baseRevision={state.configRevision}
                editable={state.editable}
                focusField={focusField}
                initialSettings={state.baseSettings}
                savedSettings={state.savedSettings}
                watcherId={watcher.id}
                watcherVersion={state.watcherVersion}
              />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          {running ? (
            <dl className="flex flex-col">
              {currentSettingsRows(running.settings).map((row) => (
                <div
                  className="grid grid-cols-1 gap-1 border-t py-2.5 first:border-t-0 first:pt-0 last:pb-0 sm:grid-cols-[minmax(160px,220px)_minmax(0,1fr)] sm:gap-3"
                  key={row.key}
                >
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="min-w-0">
                    <SettingValue value={row.value} />
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <EmptyState icon={FileText} size="compact">
              {watcher.configYaml
                ? "The watcher's config file couldn't be read. The raw YAML is below."
                : "No config pushed yet."}
            </EmptyState>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            Every change, from Data Hub or from the config file on the PC.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <WatcherConfigHistory
            canRestore={canEdit && state.editable}
            restartPendingRevision={state.restartPending?.revision ?? null}
            revisions={history}
            savedSettings={state.savedSettings}
            watcherId={watcher.id}
          />
          {watcher.configYaml ? (
            <div className="border-t pt-4">
              <WatcherYamlDisclosure>
                <div className="relative">
                  <CopyButton
                    className="absolute top-1.5 right-1.5 z-10 text-muted-foreground"
                    size="icon-sm"
                    value={watcher.configYaml}
                    variant="ghost"
                  />
                  <CodeBlock
                    className="overflow-x-auto rounded-md border bg-background text-sm dark:bg-muted [&_pre]:p-4"
                    code={watcher.configYaml}
                    lang="yaml"
                  />
                </div>
              </WatcherYamlDisclosure>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
