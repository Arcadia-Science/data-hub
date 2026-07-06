import { NotificationsSettingsFormSkeleton } from "@/components/notifications/notifications-settings-skeleton";
import { SettingsPageContent } from "@/components/settings/settings-page-content";

export default function NotificationsSettingsLoading() {
  return (
    <SettingsPageContent>
      <div>
        <h2 className="font-semibold text-lg tracking-tight">Notifications</h2>
        <p className="text-muted-foreground text-sm">
          Choose which Data Hub events to be notified about, and whether to
          receive them in-app, via Slack DM, or both. In-app and Slack are
          independent — for each type you can turn either channel on or off
          without affecting the other.
        </p>
      </div>
      <div className="mt-6">
        <NotificationsSettingsFormSkeleton isAdmin />
      </div>
    </SettingsPageContent>
  );
}
