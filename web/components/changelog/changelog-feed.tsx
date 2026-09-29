import { ExternalLink } from "lucide-react";
import { ChangelogNewBadge } from "@/components/changelog/changelog-seen";
import { DocsLink } from "@/components/docs-link";
import { CommentMarkdown } from "@/components/runs/comment-markdown";
import { changelogDateHash } from "@/lib/changelog/copy";
import type { ChangelogDaySection } from "@/lib/changelog/group";

export function ChangelogFeed({
  sections,
}: {
  sections: readonly ChangelogDaySection[];
}) {
  if (sections.length === 0) {
    return <p className="text-muted-foreground text-sm">No entries yet.</p>;
  }

  return (
    <div className="flex flex-col gap-8">
      {sections.map((section) => {
        const headingId = `changelog-day-${section.date}`;
        return (
          <section
            aria-labelledby={headingId}
            className="flex scroll-mt-6 flex-col gap-3"
            id={section.date}
            key={section.date}
          >
            <div className="px-1">
              <h2
                className="font-semibold text-[15px] leading-5"
                id={headingId}
              >
                <a
                  className="text-foreground no-underline hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  href={changelogDateHash(section.date)}
                >
                  {section.heading}
                </a>
              </h2>
            </div>
            <div className="overflow-hidden rounded-lg border bg-background dark:bg-muted">
              {section.entries.map((entry) => (
                <article
                  className="flex flex-col gap-2 border-border border-t px-5 py-[18px] first:border-t-0"
                  key={entry.id}
                >
                  <div className="flex items-start gap-2.5">
                    <h3 className="min-w-0 flex-1 font-semibold text-base leading-snug">
                      {entry.title}
                    </h3>
                    <ChangelogNewBadge id={entry.id} />
                  </div>
                  <CommentMarkdown body={entry.body} />
                  {entry.docs ? (
                    <DocsLink
                      className="inline-flex items-center gap-1.5 self-start text-sm underline underline-offset-4 hover:text-foreground/80"
                      href={entry.docs}
                    >
                      Read the docs
                      <ExternalLink
                        aria-hidden="true"
                        className="size-3.5 shrink-0"
                      />
                    </DocsLink>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
