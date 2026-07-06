import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { WatcherReleaseFormSkeleton } from "@/components/watcher-release/watcher-release-form-skeleton";

export default function WatchersSettingsLoading() {
  return (
    <SettingsPageContent>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-lg tracking-tight">
            Watcher Version
          </h2>
          <p className="text-muted-foreground text-sm">
            Configure the release advertised by{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs dark:bg-background/40">
              GET /api/v1/watchers/:id/update-check
            </code>
            . Watchers compare their installed version against{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs dark:bg-background/40">
              latest_version
            </code>{" "}
            and self-upgrade when a newer release is offered.
          </p>
        </div>
      </div>
      <div className="mt-6">
        <WatcherReleaseFormSkeleton />
      </div>
    </SettingsPageContent>
  );
}
