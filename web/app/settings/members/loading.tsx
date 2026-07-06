import { MembersTableSkeleton } from "@/components/members/members-table";
import { SettingsPageContent } from "@/components/settings/settings-page-content";

export default function MembersSettingsLoading() {
  return (
    <SettingsPageContent>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-lg tracking-tight">Members</h2>
          <p className="text-muted-foreground text-sm">
            Grant or revoke admin access for teammates signed in to Data Hub.
          </p>
        </div>
      </div>
      <div className="mt-6">
        <MembersTableSkeleton />
      </div>
    </SettingsPageContent>
  );
}
