import { BookOpen } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChangelogNewBadge } from "@/components/changelog/changelog-seen";
import { DocsLink } from "@/components/docs-link";
import type { ChangelogDaySection } from "@/lib/changelog/group";

const remarkPlugins = [remarkGfm];

const changelogMarkdown: Partial<Components> = {
  p: ({ node: _node, ...props }) => <p {...props} />,
  strong: ({ node: _node, ...props }) => (
    <strong className="font-semibold" {...props} />
  ),
  a: ({ node: _node, ...props }) => (
    <a
      {...props}
      className="font-semibold underline decoration-neutral-400 underline-offset-[3px]"
      rel="noopener noreferrer"
      target="_blank"
    />
  ),
  ul: (props: ComponentPropsWithoutRef<"ul">) => (
    <ul className="ml-5 list-disc" {...props} />
  ),
  ol: (props: ComponentPropsWithoutRef<"ol">) => (
    <ol className="ml-5 list-decimal" {...props} />
  ),
  li: (props: ComponentPropsWithoutRef<"li">) => (
    <li className="mt-1" {...props} />
  ),
  code: ({
    className,
    children,
    node: _node,
    ...props
  }: ComponentPropsWithoutRef<"code"> & { node?: unknown }) => {
    const isBlock = (className ?? "").includes("language-");
    if (isBlock) {
      return (
        <code className="font-mono text-[13px]" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="font-mono text-[0.92em]" {...props}>
        {children}
      </code>
    );
  },
  pre: (props: ComponentPropsWithoutRef<"pre">) => (
    <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2" {...props} />
  ),
  blockquote: (props: ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      className="rounded-lg border border-border bg-muted/60 px-4 py-3 text-sm leading-relaxed"
      {...props}
    />
  ),
};

function ChangelogMarkdown({ body }: { body: string }) {
  return (
    <div className="flex flex-col gap-2.5 text-[15px] text-foreground leading-[1.6]">
      <ReactMarkdown
        components={changelogMarkdown}
        remarkPlugins={remarkPlugins}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

export function ChangelogFeed({
  sections,
}: {
  sections: readonly ChangelogDaySection[];
}) {
  if (sections.length === 0) {
    return (
      <p className="py-6 text-[15px] text-muted-foreground">No entries yet.</p>
    );
  }

  return (
    <div className="px-8 pb-8">
      {sections.map((section) => {
        const headingId = `changelog-day-${section.date}`;
        return (
          <section
            aria-labelledby={headingId}
            className="border-border border-t pb-7 first:border-t-0 last:pb-0"
            key={section.date}
          >
            <h3
              className="sticky top-0 z-10 -mx-8 bg-background px-8 pt-5 pb-1.5 font-semibold text-foreground/80 text-sm"
              id={headingId}
            >
              {section.heading}
            </h3>
            <div className="flex flex-col gap-6">
              {section.entries.map((entry) => (
                <article className="flex flex-col gap-2.5" key={entry.id}>
                  <div className="flex items-start gap-4">
                    <h4 className="min-w-0 flex-1 font-semibold text-base leading-snug">
                      {entry.title}
                    </h4>
                    <ChangelogNewBadge id={entry.id} />
                  </div>
                  <ChangelogMarkdown body={entry.body} />
                  {entry.docs ? (
                    <DocsLink
                      className="inline-flex min-h-8 items-center gap-1.5 self-start font-medium text-foreground text-sm no-underline"
                      href={entry.docs}
                    >
                      <BookOpen
                        aria-hidden="true"
                        className="size-[15px] text-muted-foreground"
                      />
                      <span className="underline decoration-neutral-400 underline-offset-[3px]">
                        Read the docs
                      </span>
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
