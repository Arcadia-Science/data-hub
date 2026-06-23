import { eq } from "drizzle-orm";
import { ShieldOff } from "lucide-react";
import type { Metadata } from "next/types";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { WatcherReleaseForm } from "@/components/watcher-release/watcher-release-form";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users, watcherReleaseConfig } from "@/lib/db/schema";

export const metadata: Metadata = {
  title: "Watchers",
  description:
    "Configure the watcher release advertised by the auto-update endpoint.",
};

export default async function WatchersSettingsPage() {
  const session = await auth();
  if (!session?.user) {
    return (
      <SignInRequired callbackUrl="/settings/watchers">
        Sign in to manage watcher settings.
      </SignInRequired>
    );
  }

  // Page-level admin gate. Non-admins reach this URL via a stale link,
  // bookmark, or by typing it in — render an explicit explanation rather
  // than redirecting silently so the missing-permission failure mode is
  // visible. The settings sidebar already hides this entry for non-admins.
  if (!session.user.isAdmin) {
    return (
      <SettingsPageContent>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-background py-16 dark:bg-muted">
          <ShieldOff className="size-10 text-muted-foreground/50" />
          <p className="mt-3 font-medium text-muted-foreground text-sm">
            Admins only
          </p>
          <p className="mt-1 max-w-sm text-center text-muted-foreground/70 text-sm">
            You need workspace admin access to change watcher settings. Ask an
            existing admin if you need to be promoted.
          </p>
        </div>
      </SettingsPageContent>
    );
  }

  // Reading directly via Drizzle (rather than round-tripping through the
  // API) avoids an extra hop on the initial render. The singleton
  // constraint means at most one row, so the left join on `user` for the
  // "last updated by" line is a constant-cost query regardless of fleet
  // size. Returns `undefined` when no admin has saved yet — the form
  // renders blank defaults in that case.
  const [row] = await db
    .select({
      latestVersion: watcherReleaseConfig.latestVersion,
      minSupportedVersion: watcherReleaseConfig.minSupportedVersion,
      channel: watcherReleaseConfig.channel,
      mandatory: watcherReleaseConfig.mandatory,
      updatedAt: watcherReleaseConfig.updatedAt,
      updatedByName: users.name,
      updatedByEmail: users.email,
    })
    .from(watcherReleaseConfig)
    .leftJoin(users, eq(users.id, watcherReleaseConfig.updatedBy));

  // Page-level heading + description match the layout used by
  // `/settings/tokens` and `/settings/members` so the h2 aligns
  // vertically with the "Settings" label in the sidebar. The form below
  // is content-only (Card body + footer) — same pattern as the table
  // components those sibling pages render.
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
        <WatcherReleaseForm
          initial={{
            latestVersion: row?.latestVersion ?? "",
            minSupportedVersion: row?.minSupportedVersion ?? "",
            channel: row?.channel ?? "stable",
            mandatory: row?.mandatory ?? false,
          }}
          // Only the primitive form values + the small "last updated"
          // metadata cross the server/client boundary — keep the
          // server/client payload minimal per `server-serialization`.
          lastUpdated={
            row
              ? {
                  at: row.updatedAt.toISOString(),
                  byName: row.updatedByName,
                  byEmail: row.updatedByEmail,
                }
              : null
          }
        />
      </div>
    </SettingsPageContent>
  );
}
