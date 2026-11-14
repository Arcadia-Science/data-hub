import { eq } from "drizzle-orm";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { AdminsOnly } from "@/components/settings/admins-only";
import { WatcherReleaseForm } from "@/components/watcher-release/watcher-release-form";
import { WatcherReleaseFormSkeleton } from "@/components/watcher-release/watcher-release-form-skeleton";
import { RolloutPill } from "@/components/watchers/rollout-pill";
import {
  WatchersView,
  WatchersViewSkeleton,
} from "@/components/watchers/watchers-view";
import { getLatestWatcherVersion } from "@/lib/api/watcher-release";
import { getWatcherRoster } from "@/lib/api/watcher-roster";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users, watcherReleaseConfig } from "@/lib/db/schema";
import { fetchWatcherVersions } from "@/lib/pypi";
import { rolloutPill, splitWatcherRoster } from "@/lib/watchers/roster";

const description =
  "The program on each instrument PC that uploads files, and the version they all run.";

export const metadata: Metadata = {
  title: "Watchers",
  description,
  openGraph: { title: "Watchers", description },
  twitter: { title: "Watchers", description },
};

export default async function WatchersSettingsPage() {
  const session = await auth();
  if (!session?.user) {
    return <SignInRequired>Sign in to manage watcher settings.</SignInRequired>;
  }

  // Page-level admin gate. Non-admins reach this URL via a stale link,
  // bookmark, or by typing it in — render an explicit explanation rather
  // than redirecting silently so the missing-permission failure mode is
  // visible. The settings sidebar already hides this entry for non-admins.
  if (!session.user.isAdmin) {
    return <AdminsOnly>change watcher settings</AdminsOnly>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-semibold text-lg tracking-tight">Watchers</h1>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>

      <Suspense fallback={<WatcherReleaseFormSkeleton />}>
        <WatcherReleaseSection />
      </Suspense>

      <Suspense fallback={<AllWatchersFallback />}>
        <AllWatchersSection />
      </Suspense>
    </div>
  );
}

async function WatcherReleaseSection() {
  // Reading directly via Drizzle (rather than round-tripping through the
  // API) avoids an extra hop on the initial render. The singleton
  // constraint means at most one row, so the left join on `user` for the
  // "last updated by" line is a constant-cost query regardless of fleet
  // size. Returns `undefined` when no admin has saved yet — the form
  // renders blank defaults in that case.
  //
  // PyPI versions are fetched in parallel with the DB read so the
  // settings page doesn't waterfall (`async-parallel`).
  const [[row], pypi] = await Promise.all([
    db
      .select({
        latestVersion: watcherReleaseConfig.latestVersion,
        minSupportedVersion: watcherReleaseConfig.minSupportedVersion,
        mandatory: watcherReleaseConfig.mandatory,
        updatedAt: watcherReleaseConfig.updatedAt,
        updatedByName: users.name,
        updatedByEmail: users.email,
      })
      .from(watcherReleaseConfig)
      .leftJoin(users, eq(users.id, watcherReleaseConfig.updatedBy)),
    fetchWatcherVersions(),
  ]);

  return (
    <WatcherReleaseForm
      availableVersions={pypi.versions}
      initial={{
        latestVersion: row?.latestVersion ?? "",
        minSupportedVersion: row?.minSupportedVersion ?? "",
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
      pypiReachable={pypi.ok}
    />
  );
}

/** The list's heading, shown while the list loads so the page doesn't shift. */
function AllWatchersFallback() {
  return (
    <section
      aria-labelledby="all-watchers-heading"
      className="flex flex-col gap-4"
    >
      <ListHeading />
      <WatchersViewSkeleton />
    </section>
  );
}

function ListHeading({ pill }: { pill?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2
          className="font-semibold text-lg tracking-tight"
          id="all-watchers-heading"
        >
          All watchers
        </h2>
        <p className="text-muted-foreground text-sm">
          One per instrument. Open a row to see its activity, health, and
          settings.
        </p>
      </div>
      {pill}
    </div>
  );
}

async function AllWatchersSection() {
  // One read for every watcher, with the computers they share and who
  // deregistered each, and the release's latest version for the pill.
  const [roster, latestVersion] = await Promise.all([
    getWatcherRoster(),
    getLatestWatcherVersion(),
  ]);
  const { active, deregistered } = splitWatcherRoster(roster);

  const pill = rolloutPill({
    activeVersions: active.map((watcher) => watcher.watcherVersion),
    latestVersion,
  });

  return (
    <section
      aria-labelledby="all-watchers-heading"
      className="flex flex-col gap-4"
    >
      <ListHeading pill={pill ? <RolloutPill pill={pill} /> : null} />
      <WatchersView activeData={active} deregisteredData={deregistered} />
    </section>
  );
}
