import { FileText } from "lucide-react";
import { CodeBlock } from "@/components/code-block";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { WatcherConfigForm } from "@/components/watchers/watcher-config-form";
import { WatcherConfigHistory } from "@/components/watchers/watcher-config-history";
import {
  ConfigChangeCallout,
  RestartPendingCallout,
  UnreadableConfigCallout,
} from "@/components/watchers/watcher-config-status";
import { WatcherYamlDisclosure } from "@/components/watchers/watcher-yaml-disclosure";
import type {
  ConfigRevision,
  WatcherConfigState,
} from "@/lib/api/watcher-config/revisions";
import { settingsDisplayRows } from "@/lib/api/watcher-config/settings";
import type { WatcherDetail } from "@/lib/api/watchers";

/**
 * The watcher's Configuration tab: what the watcher last reported, any
 * pending or rejected change, the edit form for admins, the change history,
 * and the raw YAML.
 */
export function WatcherConfig({
  watcher,
  state,
  history,
  isAdmin,
}: {
  watcher: WatcherDetail;
  state: WatcherConfigState;
  history: ConfigRevision[];
  isAdmin: boolean;
}) {
  const running = state.running;
  const isDeregistered = watcher.deletedAt !== null;
  const canEdit = isAdmin && !isDeregistered;
  const watcherOnline =
    watcher.effectiveStatus === "watching" ||
    watcher.effectiveStatus === "waiting";

  return (
    <div className="flex flex-col gap-6">
      <UnreadableConfigCallout
        hasSettings={state.baseSettings !== null}
        problem={state.reportedProblem}
      />
      <ConfigChangeCallout
        current={running?.settings ?? null}
        latest={state.latest}
        watcherOnline={watcherOnline}
      />
      <RestartPendingCallout
        revision={state.restartPending}
        running={running}
      />

      <section className="flex flex-col gap-2">
        <h4 className="font-medium text-sm">Current settings</h4>
        <p className="text-muted-foreground text-xs">
          {running?.revision
            ? `What the watcher is running: revision ${running.revision}.`
            : "As last reported by the watcher."}
        </p>
        {running ? (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border bg-background p-4 text-sm sm:grid-cols-[max-content_1fr] dark:bg-muted">
            {settingsDisplayRows(running.settings).map((row) => (
              <div className="contents" key={row.key}>
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="break-all font-mono text-[13px]">{row.value}</dd>
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
      </section>

      {canEdit && state.baseSettings ? (
        <section className="flex flex-col gap-3">
          <div>
            <h4 className="font-medium text-sm">Edit settings</h4>
            <p className="text-muted-foreground text-xs">
              Saved changes reach the watcher within about a minute. If it
              can&apos;t apply one, it keeps its current settings and the change
              shows as rejected.
            </p>
          </div>
          <div className="rounded-lg border bg-background p-4 dark:bg-muted">
            <WatcherConfigForm
              baseRevision={state.configRevision}
              editable={state.editable}
              initialSettings={state.baseSettings}
              key={state.configRevision ?? "none"}
              savedSettings={state.savedSettings}
              watcherId={watcher.id}
              watcherVersion={state.watcherVersion}
            />
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h4 className="font-medium text-sm">History</h4>
        <WatcherConfigHistory
          canRestore={canEdit && state.editable}
          restartPendingRevision={state.restartPending?.revision ?? null}
          revisions={history}
          savedSettings={state.savedSettings}
          watcherId={watcher.id}
        />
      </section>

      {watcher.configYaml ? (
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
      ) : null}
    </div>
  );
}
