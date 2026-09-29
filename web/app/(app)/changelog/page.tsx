import type { Metadata } from "next";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { ChangelogFeed } from "@/components/changelog/changelog-feed";
import { ChangelogJumpNav } from "@/components/changelog/changelog-jump-nav";
import {
  ChangelogSeenProvider,
  ChangelogSummary,
} from "@/components/changelog/changelog-seen";
import { auth } from "@/lib/auth";
import { listChangelogEntries } from "@/lib/changelog/entries";
import { groupChangelogByDate } from "@/lib/changelog/group";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

export const metadata: Metadata = {
  title: "Changelog",
  description: "What has changed in Data Hub.",
};

export default async function ChangelogPage() {
  const session = await auth();
  if (!session) {
    return (
      <SignInRequired callbackUrl="/changelog">
        Sign in to read the changelog.
      </SignInRequired>
    );
  }

  const entries = listChangelogEntries();
  const timeZone = await getViewerTimeZone();
  const sections = groupChangelogByDate(entries, timeZone);

  return (
    <div className="p-6">
      <ChangelogSeenProvider ids={entries.map((entry) => entry.id)}>
        <div className="mx-auto grid w-full max-w-[1040px] grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_272px] lg:gap-x-12">
          <div className="flex flex-col gap-2 lg:col-start-1 lg:row-start-1">
            <h1 className="font-medium text-2xl tracking-tight">Changelog</h1>
            <ChangelogSummary />
          </div>
          <aside className="lg:col-start-2 lg:row-start-2">
            <ChangelogJumpNav
              dates={sections.map((section) => ({
                date: section.date,
                label: section.jumpLabel,
              }))}
            />
          </aside>
          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            <ChangelogFeed sections={sections} />
          </div>
        </div>
      </ChangelogSeenProvider>
    </div>
  );
}
