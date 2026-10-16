"use client";

import { BookOpen } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  useEffect,
  useMemo,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChangelogNewBadge,
  useChangelogUnseenIds,
} from "@/components/changelog/changelog-seen";
import { CopyEntryLinkButton } from "@/components/changelog/copy-entry-link-button";
import { DocsLink } from "@/components/docs-link";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { initialExpandedIds } from "@/lib/changelog/expanded";
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

const NOTHING_NEW: ReadonlySet<string> = new Set();

function entryDomId(entryId: string): string {
  return `changelog-entry-${entryId}`;
}

// Puts the linked entry at the top of the window, just under its day heading.
// It reads `offsetTop` instead of calling `scrollIntoView` because the window
// is still zooming in when this runs, and a transform skews the rectangles
// `scrollIntoView` measures. The window's scroll area is positioned, so it is
// the entry's `offsetParent`.
function scrollToEntry(entryId: string) {
  const item = document.getElementById(entryDomId(entryId));
  const scroller = item?.offsetParent;
  if (!(item && scroller instanceof HTMLElement)) {
    return;
  }
  const dayHeading = item.closest("section")?.querySelector("h3");
  scroller.scrollTop = item.offsetTop - (dayHeading?.offsetHeight ?? 0);
}

export function ChangelogFeed({
  linkedId,
  sections,
}: {
  /** The entry a link asked for. The window opens on it. */
  linkedId: string | null;
  sections: readonly ChangelogDaySection[];
}) {
  const unseenIds = useChangelogUnseenIds();
  const ids = useMemo(
    () => sections.flatMap((section) => section.entries.map((e) => e.id)),
    [sections]
  );
  // Held from the first render. Closing a linked window clears the link from
  // the address, and that must not reshuffle the entries as it fades out.
  const [openedFor] = useState(linkedId);
  const [chosen, setChosen] = useState<string[] | null>(null);

  const linkIsKnown = openedFor !== null && ids.includes(openedFor);
  // Until storage is read, nothing is known to be new. Waiting keeps the
  // newest entry from flashing open and then closing.
  const waitingForSeen = unseenIds === null && !linkIsKnown;
  const expanded =
    chosen ??
    (waitingForSeen
      ? []
      : initialExpandedIds({
          ids,
          linkedId: openedFor,
          unseenIds: unseenIds ?? NOTHING_NEW,
        }));

  useEffect(() => {
    if (openedFor !== null) {
      scrollToEntry(openedFor);
    }
  }, [openedFor]);

  if (sections.length === 0) {
    return (
      <p className="py-6 text-[15px] text-muted-foreground">No entries yet.</p>
    );
  }

  return (
    <Accordion
      className="px-8 pb-8"
      onValueChange={setChosen}
      type="multiple"
      value={expanded}
    >
      {sections.map((section) => {
        const headingId = `changelog-day-${section.date}`;
        return (
          <section
            aria-labelledby={headingId}
            className="pb-5 last:pb-0"
            key={section.date}
          >
            <h3
              className="sticky top-0 z-10 -mx-8 bg-background px-8 pt-5 pb-3 font-semibold text-foreground/80 text-sm"
              id={headingId}
            >
              {section.heading}
            </h3>
            <div className="flex flex-col">
              {section.entries.map((entry) => (
                <AccordionItem
                  id={entryDomId(entry.id)}
                  key={entry.id}
                  value={entry.id}
                >
                  <AccordionTrigger
                    className="-mx-2 cursor-pointer items-center gap-3 px-2 py-3.5 font-semibold text-base leading-snug hover:no-underline"
                    headingLevel={4}
                  >
                    <span className="min-w-0 flex-1">{entry.title}</span>
                    <ChangelogNewBadge id={entry.id} />
                  </AccordionTrigger>
                  {/* `h-auto` drops the height the accordion pins from a
                      measurement. Entries that start open are measured while
                      the window is still zooming in at 95% scale, which
                      leaves them about 5% short and clips the last row. */}
                  <AccordionContent className="flex h-auto flex-col gap-3 pb-5 [&_p:not(:last-child)]:mb-0">
                    <ChangelogMarkdown body={entry.body} />
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
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
                      <CopyEntryLinkButton
                        entryId={entry.id}
                        title={entry.title}
                      />
                    </div>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </div>
          </section>
        );
      })}
    </Accordion>
  );
}
