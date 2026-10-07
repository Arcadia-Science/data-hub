"use client";

import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  XIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import { parseAsString, useQueryState } from "nuqs";
import { useState } from "react";
import {
  FeedbackLabelChip,
  FeedbackPriority,
} from "@/components/feedback/feedback-badges";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { UserAvatar } from "@/components/user-avatar";
import type {
  FeedbackActivityEvent,
  FeedbackAssignee,
  FeedbackLabel,
} from "@/lib/api/feedback";
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_LABELS,
  type FeedbackKind,
  type FeedbackStatus,
} from "@/lib/api/feedback-schema";
import { toUserAvatarUser } from "@/lib/avatar-color";
import { formatDateTime, formatDateTimeShort } from "@/lib/date";

const CommentMarkdown = dynamic(
  () =>
    import("@/components/runs/comment-markdown").then(
      (mod) => mod.CommentMarkdown
    ),
  {
    loading: () => (
      <div className="py-1 text-muted-foreground text-sm">Loading…</div>
    ),
  }
);

export interface FeedbackDetail {
  activity: FeedbackActivityEvent[];
  assignee: FeedbackAssignee | null;
  attemptedAction: string | null;
  createdAt: string;
  description: string;
  errorMessage: string | null;
  id: string;
  identifier: string;
  kind: FeedbackKind;
  labels: FeedbackLabel[];
  linearUrl: string | null;
  pageUrl: string | null;
  priority: number | null;
  priorityLabel: string | null;
  projectName: string | null;
  // First word of the reporter's name, for "Matt sees Open". Null when the
  // reporter's account is gone.
  reporterFirstName: string | null;
  reporterName: string;
  stateColor: string;
  stateName: string;
  status: FeedbackStatus;
  teamName: string;
  title: string;
  toolName: string | null;
  viaLabel: string | null;
}

export function FeedbackDetailSheet({
  item,
  navIds,
  statusLabel,
  total,
}: {
  item: FeedbackDetail | null;
  navIds: string[];
  statusLabel: string;
  // Reports in the whole tab, across every page of the table.
  total: number;
}) {
  const [itemId, setItem] = useQueryState(
    "item",
    parseAsString.withOptions({ shallow: false, history: "push" })
  );
  // Keep the last loaded report mounted while the sheet animates closed.
  // `item` comes from the server and is cleared only after the URL refresh.
  const [displayed, setDisplayed] = useState(item);
  if (item && item !== displayed) {
    setDisplayed(item);
  }
  const shown = displayed;
  const index = shown ? navIds.indexOf(shown.id) : -1;

  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          void setItem(null);
        }
      }}
      open={itemId !== null && shown !== null}
    >
      {shown ? (
        <SheetContent
          className="w-full gap-0 overflow-hidden p-0 shadow-[-16px_0_40px_rgba(24,24,27,0.10)] sm:w-[560px]! sm:max-w-[560px]!"
          overlayClassName="bg-zinc-950/30 backdrop-blur-none"
          showCloseButton={false}
        >
          <SheetHeader className="shrink-0 gap-3 border-b px-6 pt-4 pb-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <Button
                  aria-label="Previous report"
                  disabled={index <= 0}
                  onClick={() => {
                    const previous = navIds[index - 1];
                    if (previous) {
                      void setItem(previous);
                    }
                  }}
                  size="icon-sm"
                  type="button"
                  variant="outline"
                >
                  <ChevronLeftIcon />
                </Button>
                <Button
                  aria-label="Next report"
                  disabled={index < 0 || index >= navIds.length - 1}
                  onClick={() => {
                    const next = navIds[index + 1];
                    if (next) {
                      void setItem(next);
                    }
                  }}
                  size="icon-sm"
                  type="button"
                  variant="outline"
                >
                  <ChevronRightIcon />
                </Button>
                {index >= 0 ? (
                  <span className="ml-2 text-[13px] text-muted-foreground tabular-nums">
                    {index + 1} of {navIds.length}{" "}
                    {total > navIds.length ? "on this page" : statusLabel}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1">
                <CopyReportButton item={shown} key={shown.id} />
                <SheetClose asChild>
                  <Button
                    aria-label="Close"
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <XIcon aria-hidden="true" />
                  </Button>
                </SheetClose>
              </div>
            </div>
            <p className="font-mono text-muted-foreground text-xs">
              {shown.identifier}
            </p>
            <SheetTitle className="text-pretty break-words font-semibold text-[22px] leading-snug tracking-tight">
              {shown.title}
            </SheetTitle>
            <SheetDescription className="text-sm text-zinc-600 dark:text-zinc-400">
              {sentSentence(shown)}
            </SheetDescription>
            {shown.linearUrl ? (
              <div>
                <a
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                  href={shown.linearUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Open in Linear
                  <ExternalLinkIcon aria-hidden="true" data-icon="inline-end" />
                </a>
              </div>
            ) : null}
          </SheetHeader>
          <div className="border-b px-6 py-4">
            <LinearProperties item={shown} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto overscroll-contain px-6 py-6">
            <ReportBody item={shown} key={shown.id} />
            <Activity item={shown} />
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

function CopyReportButton({ item }: { item: FeedbackDetail }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      aria-label={copied ? "Copied" : "Copy feedback"}
      aria-live="polite"
      onClick={() => {
        navigator.clipboard.writeText(feedbackMarkdown(item)).then(
          () => setCopied(true),
          () => setCopied(false)
        );
      }}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      {copied ? (
        <CheckIcon aria-hidden="true" />
      ) : (
        <CopyIcon aria-hidden="true" />
      )}
    </Button>
  );
}

function feedbackMarkdown(item: FeedbackDetail): string {
  const page = item.pageUrl ? pageParts(item.pageUrl) : null;
  const sections = [
    `# ${item.identifier} ${item.title}`,
    "",
    `**Reporter:** ${item.reporterName}`,
    `**Received:** ${formatDateTime(new Date(item.createdAt))}`,
    `**Status:** ${item.stateName} (${FEEDBACK_STATUS_LABELS[item.status]})`,
    `**Type:** ${FEEDBACK_KIND_LABELS[item.kind]}`,
    `**Priority:** ${item.priorityLabel ?? "No priority"}`,
    `**Assignee:** ${item.assignee?.name ?? "Unassigned"}`,
    `**Project:** ${item.projectName ?? "None"}`,
    `**Team:** ${item.teamName}`,
    "",
    "## Description",
    "",
    item.description,
  ];

  if (item.attemptedAction) {
    sections.push("", "## Trying to do", "", item.attemptedAction);
  }

  if (page) {
    sections.push(
      "",
      "## Page",
      "",
      `[${page.label}](${page.href})`,
      "",
      `\`${page.path}\``
    );
  } else if (item.pageUrl) {
    sections.push("", "## Page", "", item.pageUrl);
  }

  if (item.toolName || item.errorMessage) {
    sections.push("", "## Technical details");
    if (item.toolName) {
      sections.push("", "**Tool**", "", fenced(item.toolName));
    }
    if (item.errorMessage) {
      sections.push("", "**Error message**", "", fenced(item.errorMessage));
    }
  }

  sections.push("", "## Activity", "");
  for (const event of activityEvents(item)) {
    sections.push(`- ${event.text} — ${formatDateTime(new Date(event.at))}`);
    if (event.body) {
      sections.push("", event.body, "");
    }
  }

  return sections.join("\n").trimEnd();
}

function fenced(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  let longest = 0;
  for (const run of runs) {
    if (run.length > longest) {
      longest = run.length;
    }
  }
  const marker = "`".repeat(Math.max(3, longest + 1));
  return `${marker}\n${text}\n${marker}`;
}

function ReportBody({ item }: { item: FeedbackDetail }) {
  const page = item.pageUrl ? pageParts(item.pageUrl) : null;
  const hasTech = Boolean(item.toolName || item.errorMessage);
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h3 className="font-medium text-[13px] text-muted-foreground">
          Description
        </h3>
        <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
          {item.description}
        </p>
      </div>
      {item.attemptedAction ? (
        <div className="flex flex-col gap-1.5">
          <h3 className="font-medium text-[13px] text-muted-foreground">
            Trying to do
          </h3>
          <p className="whitespace-pre-wrap break-words text-sm leading-normal">
            {item.attemptedAction}
          </p>
        </div>
      ) : null}
      {page ? (
        <div className="flex flex-col gap-1.5">
          <h3 className="font-medium text-[13px] text-muted-foreground">
            Page
          </h3>
          <PageLink page={page} />
        </div>
      ) : null}
      {hasTech ? (
        <TechnicalDetails
          errorMessage={item.errorMessage}
          toolName={item.toolName}
        />
      ) : null}
    </section>
  );
}

function TechnicalDetails({
  errorMessage,
  toolName,
}: {
  errorMessage: string | null;
  toolName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const summary = techSummary(toolName, errorMessage);

  return (
    <Collapsible
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setCopied(false);
        }
      }}
      open={open}
    >
      <CollapsibleTrigger className="inline-flex min-h-8 items-center gap-2 font-medium text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {open ? (
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        ) : (
          <ChevronRightIcon aria-hidden="true" className="size-4" />
        )}
        Technical details
        <span className="font-normal text-muted-foreground">{summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="relative mt-2.5 flex flex-col gap-3.5 rounded-[10px] border bg-zinc-100 p-3.5 pr-4 dark:bg-zinc-900">
        <Button
          className="absolute top-2.5 right-2.5 h-[30px] rounded-lg px-2.5 text-xs"
          onClick={() => {
            const text = technicalText(toolName, errorMessage);
            navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => setCopied(false)
            );
          }}
          type="button"
          variant="outline"
        >
          {copied ? (
            <CheckIcon aria-hidden="true" className="size-3.5" />
          ) : (
            <CopyIcon aria-hidden="true" className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
        {toolName ? (
          <div className="flex flex-col gap-1 pr-20">
            <p className="font-medium text-muted-foreground text-xs">Tool</p>
            <code
              className="whitespace-pre-wrap break-words font-mono text-[13px] leading-normal"
              translate="no"
            >
              {toolName}
            </code>
          </div>
        ) : null}
        {errorMessage ? (
          <div className="flex flex-col gap-1">
            <p className="font-medium text-muted-foreground text-xs">
              Error message
            </p>
            <code
              className="whitespace-pre-wrap break-words font-mono text-[13px] leading-normal"
              translate="no"
            >
              {errorMessage}
            </code>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function sentSentence(item: FeedbackDetail): string {
  const from = item.viaLabel ?? "the web app";
  return `${item.reporterName} sent this from ${from} on ${formatDateTime(new Date(item.createdAt))}.`;
}

function reporterSees(item: FeedbackDetail): string {
  const who = item.reporterFirstName ?? "The reporter";
  return `${who} sees ${FEEDBACK_STATUS_LABELS[item.status]}`;
}

function LinearProperties({ item }: { item: FeedbackDetail }) {
  const assignee = item.assignee
    ? toUserAvatarUser({
        userId: item.assignee.userId,
        name: item.assignee.name,
        email: item.assignee.email,
        image: item.assignee.avatarUrl,
      })
    : null;
  return (
    <>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2.5 text-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium text-xs">
            <span
              aria-hidden="true"
              className="size-2 rounded-full"
              style={{ backgroundColor: item.stateColor }}
            />
            {item.stateName}
          </span>
          <span className="text-muted-foreground text-xs">
            {reporterSees(item)}
          </span>
        </dd>
        <dt className="text-muted-foreground">Priority</dt>
        <dd>
          <FeedbackPriority
            label={item.priorityLabel}
            priority={item.priority}
          />
        </dd>
        <dt className="text-muted-foreground">Assignee</dt>
        <dd>
          {assignee ? (
            <span className="inline-flex items-center gap-2">
              <UserAvatar size="sm" user={assignee} />
              {assignee.displayName}
            </span>
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          )}
        </dd>
        <dt className="text-muted-foreground">Labels</dt>
        <dd className="flex flex-wrap gap-1.5">
          {item.labels.length > 0 ? (
            item.labels.map((label) => (
              <FeedbackLabelChip
                color={label.color}
                key={label.name}
                name={label.name}
              />
            ))
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </dd>
        <dt className="text-muted-foreground">Project</dt>
        <dd>{item.projectName ?? "None"}</dd>
        <dt className="text-muted-foreground">Team</dt>
        <dd>{item.teamName}</dd>
      </dl>
      <p className="mt-3.5 text-muted-foreground text-xs">
        These come from Linear. To change them, open the issue there.
      </p>
    </>
  );
}

function Activity({ item }: { item: FeedbackDetail }) {
  const events = activityEvents(item);
  return (
    <section className="flex flex-col gap-3.5 border-t pt-6">
      <h3 className="font-medium text-[13px] text-muted-foreground">
        Activity
      </h3>
      <ol className="flex flex-col">
        {events.map((event, index) => (
          <li className="flex gap-3" key={`${event.at}-${event.text}`}>
            <div className="flex w-3 shrink-0 flex-col items-center">
              <span
                aria-hidden="true"
                className="mt-1.5 size-[9px] rounded-full bg-zinc-400"
                style={
                  event.color ? { backgroundColor: event.color } : undefined
                }
              />
              {index < events.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="mt-1 w-px flex-1 bg-border"
                />
              ) : null}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1 pb-[18px]">
              <p className="text-sm text-zinc-700 leading-normal dark:text-zinc-300">
                {event.text}
              </p>
              {event.body ? (
                <div className="rounded-lg bg-muted px-3 py-2">
                  <CommentMarkdown body={event.body} />
                </div>
              ) : null}
              <time
                className="text-[13px] text-muted-foreground tabular-nums"
                dateTime={event.at}
              >
                {formatDateTimeShort(new Date(event.at))}
              </time>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function activityEvents(item: FeedbackDetail): {
  at: string;
  body: string | null;
  color: string | null;
  text: string;
}[] {
  const from = item.viaLabel ?? "the web app";
  const events: {
    at: string;
    body: string | null;
    color: string | null;
    text: string;
  }[] = [
    {
      at: item.createdAt,
      body: null,
      color: null,
      text: `${item.reporterName} sent this report from ${from}. Linear filed it as ${item.identifier}.`,
    },
  ];
  for (const event of item.activity) {
    const actor = event.actorName ?? "Someone";
    if (event.kind === "comment") {
      events.push({
        at: event.at,
        body: event.body,
        color: null,
        text: `${actor} commented in Linear:`,
      });
      continue;
    }
    const moved =
      event.fromState && event.toState
        ? `moved it from ${event.fromState} to ${event.toState}`
        : event.toState
          ? `moved it to ${event.toState}`
          : "changed its status";
    events.push({
      at: event.at,
      body: null,
      color: event.toStateColor,
      text: `${actor} ${moved}.`,
    });
  }
  return events;
}

function techSummary(
  toolName: string | null,
  errorMessage: string | null
): string {
  if (toolName && errorMessage) {
    return "Tool and error message";
  }
  if (toolName) {
    return "Tool";
  }
  return "Error message";
}

function technicalText(
  toolName: string | null,
  errorMessage: string | null
): string {
  return [
    toolName ? `Tool: ${toolName}` : "",
    errorMessage ? `Error message: ${errorMessage}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

interface PageParts {
  href: string;
  label: string;
  path: string;
}

function PageLink({ page }: { page: PageParts }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <a
        className="inline-flex items-center gap-1.5 font-medium underline decoration-zinc-400 underline-offset-[3px] hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        href={page.href}
        rel="noreferrer"
      >
        <span className="truncate">{page.label}</span>
        <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
      </a>
      <span
        className="truncate font-mono text-muted-foreground text-xs"
        translate="no"
      >
        {page.path}
      </span>
    </div>
  );
}

function pageParts(url: string): PageParts | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment.length > 0);
  return {
    href: parsed.href,
    label: pageLabel(segments),
    path: `${parsed.pathname}${parsed.search}`,
  };
}

function pageLabel(segments: string[]): string {
  if (segments[0] === "instruments" && segments[1]) {
    const name = humanizeSlug(segments[1]);
    if (segments[2] === "runs" && segments[3]) {
      return `${name}, run ${segments[3]}`;
    }
    return name;
  }
  const last = segments.at(-1);
  if (!last) {
    return "Page";
  }
  return humanizeSlug(last);
}

function humanizeSlug(slug: string): string {
  const words = decodeURIComponent(slug).replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
