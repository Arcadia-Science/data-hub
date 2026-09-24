import { ShieldOff } from "lucide-react";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { FeedbackDetailSheet } from "@/components/feedback/feedback-detail-sheet";
import { FeedbackReview } from "@/components/feedback/feedback-review";
import {
  FeedbackTable,
  FeedbackTableSkeleton,
} from "@/components/feedback/feedback-table";
import { PaginationNav } from "@/components/pagination-nav";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import {
  countFeedbackByStatus,
  getFeedbackForViewer,
  listFeedback,
} from "@/lib/api/feedback";
import { FEEDBACK_PAGE_SIZE } from "@/lib/api/feedback-schema";
import { isValidUUID } from "@/lib/api/validators";
import { auth } from "@/lib/auth";
import { feedbackParamsCache } from "@/lib/search-params";

const description = "Review bugs and requests sent about Data Hub.";

export const metadata: Metadata = {
  title: "Feedback",
  description,
  openGraph: { title: "Feedback", description },
  twitter: { title: "Feedback", description },
};

export default async function FeedbackSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) {
    return (
      <SignInRequired callbackUrl="/settings/feedback">
        Sign in to review feedback.
      </SignInRequired>
    );
  }

  if (!session.user.isAdmin) {
    return (
      <SettingsPageContent>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-background py-16 dark:bg-muted">
          <ShieldOff className="size-10 text-muted-foreground/50" />
          <p className="mt-3 font-medium text-muted-foreground text-sm">
            Admins only
          </p>
          <p className="mt-1 max-w-sm text-center text-muted-foreground/70 text-sm">
            You need workspace admin access to review feedback. Ask an existing
            admin if you need to be promoted.
          </p>
        </div>
      </SettingsPageContent>
    );
  }

  const filters = feedbackParamsCache.parse(await searchParams);

  return (
    <SettingsPageContent className="w-3/4">
      <div>
        <h2 className="text-pretty font-semibold text-lg tracking-tight">
          Feedback
        </h2>
        <p className="text-muted-foreground text-sm">
          Bugs and requests about Data Hub, sent from the app or an agent.
        </p>
      </div>
      <div className="mt-6">
        <Suspense fallback={<FeedbackTableSkeleton />}>
          <FeedbackSection
            itemId={filters.item}
            page={filters.page}
            status={filters.status}
            userId={session.user.id}
          />
        </Suspense>
      </div>
    </SettingsPageContent>
  );
}

async function FeedbackSection({
  itemId,
  page,
  status,
  userId,
}: {
  itemId: string | null;
  page: number;
  status: "open" | "resolved" | "declined";
  userId: string;
}) {
  const viewer = { viewerId: userId, isAdmin: true };
  const [list, counts, selected] = await Promise.all([
    listFeedback({
      ...viewer,
      status,
      limit: FEEDBACK_PAGE_SIZE,
      offset: (page - 1) * FEEDBACK_PAGE_SIZE,
    }),
    countFeedbackByStatus(viewer),
    itemId && isValidUUID(itemId)
      ? getFeedbackForViewer(itemId, viewer)
      : Promise.resolve(null),
  ]);

  const totalPages = Math.max(1, Math.ceil(list.total / FEEDBACK_PAGE_SIZE));

  function hrefFor(id: string) {
    const params = new URLSearchParams();
    if (status !== "open") {
      params.set("status", status);
    }
    if (page > 1) {
      params.set("page", String(page));
    }
    params.set("item", id);
    return `/settings/feedback?${params.toString()}`;
  }

  return (
    <>
      <FeedbackReview counts={counts}>
        <FeedbackTable
          hrefFor={hrefFor}
          rows={list.items.map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            reporterLabel:
              item.reporter?.name ?? item.reporter?.email ?? "Deleted user",
            sourceLabel:
              item.source === "web" ? "Web" : (item.oauthClientName ?? "Agent"),
            createdAt: item.createdAt.toISOString(),
          }))}
          status={status}
        />
        <PaginationNav page={page} pageParam="page" totalPages={totalPages} />
      </FeedbackReview>
      <FeedbackDetailSheet
        item={
          selected
            ? {
                id: selected.id,
                kind: selected.kind,
                title: selected.title,
                description: selected.description,
                attemptedAction: selected.attemptedAction,
                toolName: selected.toolName,
                errorMessage: selected.errorMessage,
                pageUrl: selected.pageUrl,
                status: selected.status,
                adminNote: selected.adminNote,
                createdAt: selected.createdAt.toISOString(),
                reporterLabel:
                  selected.reporter?.name ??
                  selected.reporter?.email ??
                  "Deleted user",
                statusUpdatedAt:
                  selected.statusUpdatedAt?.toISOString() ?? null,
                statusUpdatedByLabel:
                  selected.statusUpdatedBy?.name ??
                  selected.statusUpdatedBy?.email ??
                  null,
                sourceLabel:
                  selected.source === "web"
                    ? "Web"
                    : (selected.oauthClientName ?? "Agent"),
              }
            : null
        }
      />
    </>
  );
}
