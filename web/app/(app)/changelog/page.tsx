import type { Metadata } from "next";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { MarkChangelogSeen } from "@/components/changelog/mark-changelog-seen";
import { DocsLink } from "@/components/docs-link";
import { CommentMarkdown } from "@/components/runs/comment-markdown";
import { auth } from "@/lib/auth";
import { listChangelogEntries } from "@/lib/changelog/entries";
import type { ChangelogEntry } from "@/lib/changelog/parse";
import { formatCommentDayHeading } from "@/lib/comments/group-by-day";
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
  const sections = groupByDate(entries, timeZone);

  return (
    <div className="p-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
        <h1 className="font-medium text-2xl tracking-tight">Changelog</h1>
        <MarkChangelogSeen ids={entries.map((entry) => entry.id)} />
        {sections.length === 0 ? (
          <p className="text-muted-foreground text-sm">No entries yet.</p>
        ) : (
          sections.map((section) => (
            <section className="flex flex-col gap-6" key={section.date}>
              <h2 className="text-muted-foreground text-sm">{section.label}</h2>
              {section.entries.map((entry) => (
                <article className="flex flex-col gap-2" key={entry.id}>
                  <h3 className="font-medium text-base">{entry.title}</h3>
                  <CommentMarkdown body={entry.body} />
                  {entry.docs ? (
                    <DocsLink
                      className="text-primary text-sm underline underline-offset-2 hover:no-underline"
                      href={entry.docs}
                    >
                      Learn more
                    </DocsLink>
                  ) : null}
                </article>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function groupByDate(entries: ChangelogEntry[], timeZone: string) {
  const now = new Date();
  const sections: {
    date: string;
    label: string;
    entries: ChangelogEntry[];
  }[] = [];

  for (const entry of entries) {
    const current = sections.at(-1);
    if (current?.date === entry.date) {
      current.entries.push(entry);
      continue;
    }
    sections.push({
      date: entry.date,
      label: formatCommentDayHeading(entry.date, timeZone, now),
      entries: [entry],
    });
  }

  return sections;
}
