import Link from "next/link";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { feedbackStatusLabel } from "@/components/feedback/feedback-badges";
import { FeedbackDetailSheet } from "@/components/feedback/feedback-detail-sheet";
import { FeedbackReview } from "@/components/feedback/feedback-review";
import {
  FeedbackTable,
  FeedbackTableSkeleton,
} from "@/components/feedback/feedback-table";
import { PaginationNav } from "@/components/pagination-nav";
import { AdminsOnly } from "@/components/settings/admins-only";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { getFeedbackForViewer, listFeedback } from "@/lib/api/feedback";
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
    return <AdminsOnly>review feedback</AdminsOnly>;
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
  const [list, detail] = await Promise.all([
    listFeedback({
      ...viewer,
      status,
      limit: FEEDBACK_PAGE_SIZE,
      offset: (page - 1) * FEEDBACK_PAGE_SIZE,
    }),
    itemId && isValidUUID(itemId)
      ? getFeedbackForViewer(itemId, viewer)
      : Promise.resolve(null),
  ]);
  if (!list.ok) {
    return (
      <p className="text-muted-foreground text-sm">
        {list.message}{" "}
        <Link
          className="underline underline-offset-2"
          href="/settings/integrations"
        >
          Open Integrations
        </Link>
      </p>
    );
  }
  const selected = detail?.ok ? detail.item : null;

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
      <FeedbackReview counts={list.counts}>
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
          selectedId={itemId}
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
                createdAt: selected.createdAt.toISOString(),
                reporterLabel:
                  selected.reporter?.name ??
                  selected.reporter?.email ??
                  "Deleted user",
                statusUpdatedAt:
                  selected.statusUpdatedAt?.toISOString() ?? null,
                sourceLabel:
                  selected.source === "web"
                    ? "Web"
                    : (selected.oauthClientName ?? "Agent"),
                linearUrl: selected.linearIssue.url,
              }
            : null
        }
        navIds={list.items.map((item) => item.id)}
        statusLabel={feedbackStatusLabel(status)}
      />
    </>
  );
}
