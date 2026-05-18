import { SignInRequired } from "@/components/auth/sign-in-required";
import { WatcherReleaseForm } from "@/components/watcher-release/watcher-release-form";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users, watcherReleaseConfig } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { ShieldOff } from "lucide-react";
import type { Metadata } from "next/types";

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
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-background py-16 dark:bg-muted">
        <ShieldOff className="size-10 text-muted-foreground/50" />
        <p className="mt-3 text-sm font-medium text-muted-foreground">
          Admins only
        </p>
        <p className="mt-1 max-w-sm text-center text-sm text-muted-foreground/70">
          You need workspace admin access to change watcher settings. Ask an
          existing admin if you need to be promoted.
        </p>
      </div>
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

  // The form owns its own Card chrome (heading, description, fields,
  // footer) so it renders as a self-contained settings panel. The page
  // just wires server-fetched state into it.
  return (
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
  );
}
