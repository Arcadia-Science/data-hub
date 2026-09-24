"use client";

import { parseAsString, useQueryState } from "nuqs";
import {
  FeedbackKindBadge,
  FeedbackStatusBadge,
} from "@/components/feedback/feedback-badges";
import { FeedbackStatusForm } from "@/components/feedback/feedback-status-form";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { FeedbackKind, FeedbackStatus } from "@/lib/api/feedback-schema";
import { formatDateTime } from "@/lib/date";

export interface FeedbackDetail {
  adminNote: string | null;
  attemptedAction: string | null;
  createdAt: string;
  description: string;
  errorMessage: string | null;
  id: string;
  kind: FeedbackKind;
  pageUrl: string | null;
  reporterLabel: string;
  sourceLabel: string;
  status: FeedbackStatus;
  title: string;
  toolName: string | null;
}

export function FeedbackDetailSheet({ item }: { item: FeedbackDetail | null }) {
  const [, setItem] = useQueryState(
    "item",
    parseAsString.withOptions({ shallow: false, history: "push" })
  );

  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          void setItem(null);
        }
      }}
      open={item !== null}
    >
      {item ? (
        <SheetContent className="overflow-y-auto overscroll-contain sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="text-pretty break-words pr-8">
              {item.title}
            </SheetTitle>
            <SheetDescription>
              {item.reporterLabel} ·{" "}
              <time dateTime={item.createdAt} suppressHydrationWarning>
                {formatDateTime(new Date(item.createdAt))}
              </time>
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4 pb-6">
            <div className="flex flex-wrap gap-2">
              <FeedbackKindBadge kind={item.kind} />
              <FeedbackStatusBadge status={item.status} />
              <span className="text-muted-foreground text-sm" translate="no">
                {item.sourceLabel}
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">
              {item.description}
            </p>
            {item.attemptedAction ? (
              <Detail label="What they were trying to do">
                {item.attemptedAction}
              </Detail>
            ) : null}
            {item.toolName ? (
              <Detail label="Tool">
                <code translate="no">{item.toolName}</code>
              </Detail>
            ) : null}
            {item.errorMessage ? (
              <Detail label="Error">
                <code
                  className="whitespace-pre-wrap break-words"
                  translate="no"
                >
                  {item.errorMessage}
                </code>
              </Detail>
            ) : null}
            {item.pageUrl ? (
              <Detail label="Page">
                <PageLink url={item.pageUrl} />
              </Detail>
            ) : null}
            <FeedbackStatusForm
              id={item.id}
              key={item.id}
              note={item.adminNote}
              status={item.status}
            />
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

function PageLink({ url }: { url: string }) {
  const href = pageHref(url);
  if (!href) {
    return (
      <span className="break-all" translate="no">
        {url}
      </span>
    );
  }
  return (
    <a
      className="break-all underline underline-offset-4"
      href={href}
      rel="noreferrer"
      translate="no"
    >
      {url}
    </a>
  );
}

function pageHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

function Detail({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="grid gap-1">
      <p className="font-medium text-sm">{label}</p>
      <div className="whitespace-pre-wrap break-words text-muted-foreground text-sm">
        {children}
      </div>
    </div>
  );
}
