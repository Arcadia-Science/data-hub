import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { Skeleton } from "@/components/ui/skeleton";

// Shared across the settings subtree (notifications, members, tokens, watchers).
// Those pages mix forms and tables, so this stays intentionally neutral: a
// title block plus a generic bordered content panel.
export default function SettingsLoading() {
  return (
    <SettingsPageContent>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="mt-6 flex flex-col gap-4 rounded-lg border bg-background p-6 dark:bg-muted">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="flex items-center justify-between" key={i}>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-64" />
            </div>
            <Skeleton className="h-6 w-10" />
          </div>
        ))}
      </div>
    </SettingsPageContent>
  );
}
