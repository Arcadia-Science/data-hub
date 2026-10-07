import { ShieldOff } from "lucide-react";
import { SettingsPageContent } from "@/components/settings/settings-page-content";

/**
 * Explains why an admin-only settings page is empty for a non-admin. Settings
 * pages render this instead of redirecting so a stale link or bookmark shows
 * the missing permission. `children` finishes the sentence "You need workspace
 * admin access to ...".
 */
export function AdminsOnly({ children }: { children: React.ReactNode }) {
  return (
    <SettingsPageContent>
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-background py-16 dark:bg-muted">
        <ShieldOff className="size-10 text-muted-foreground/50" />
        <p className="mt-3 font-medium text-muted-foreground text-sm">
          Admins only
        </p>
        <p className="mt-1 max-w-sm text-center text-muted-foreground/70 text-sm">
          You need workspace admin access to {children}. Ask an existing admin
          if you need to be promoted.
        </p>
      </div>
    </SettingsPageContent>
  );
}
