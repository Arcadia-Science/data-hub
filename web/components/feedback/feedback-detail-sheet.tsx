"use client";

import { parseAsString, useQueryState } from "nuqs";
import { useState } from "react";
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
  statusUpdatedAt: string | null;
  statusUpdatedByLabel: string | null;
  title: string;
  toolName: string | null;
}

export function FeedbackDetailSheet({ item }: { item: FeedbackDetail | null }) {
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
        <SheetContent className="overflow-y-auto overscroll-contain sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="text-pretty break-words pr-8">
              {shown.title}
            </SheetTitle>
            <SheetDescription>
              {shown.reporterLabel} ·{" "}
              <time dateTime={shown.createdAt} suppressHydrationWarning>
                {formatDateTime(new Date(shown.createdAt))}
              </time>
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4 pb-6">
            <div className="flex flex-wrap gap-2">
              <FeedbackKindBadge kind={shown.kind} />
              <FeedbackStatusBadge status={shown.status} />
              <span className="text-muted-foreground text-sm" translate="no">
                {shown.sourceLabel}
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">
              {shown.description}
            </p>
            {shown.attemptedAction ? (
              <Detail label="What they were trying to do">
                {shown.attemptedAction}
              </Detail>
            ) : null}
            {shown.toolName ? (
              <Detail label="Tool">
                <code translate="no">{shown.toolName}</code>
              </Detail>
            ) : null}
            {shown.errorMessage ? (
              <Detail label="Error">
                <code
                  className="whitespace-pre-wrap break-words"
                  translate="no"
                >
                  {shown.errorMessage}
                </code>
              </Detail>
            ) : null}
            {shown.pageUrl ? (
              <Detail label="Page">
                <PageLink url={shown.pageUrl} />
              </Detail>
            ) : null}
            {shown.statusUpdatedAt ? (
              <p className="text-muted-foreground text-sm">
                Status last changed
                {shown.statusUpdatedByLabel
                  ? ` by ${shown.statusUpdatedByLabel}`
                  : ""}{" "}
                <time dateTime={shown.statusUpdatedAt} suppressHydrationWarning>
                  {formatDateTime(new Date(shown.statusUpdatedAt))}
                </time>
              </p>
            ) : null}
            <FeedbackStatusForm
              id={shown.id}
              key={shown.id}
              note={shown.adminNote}
              status={shown.status}
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
