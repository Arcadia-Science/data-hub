import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { after } from "next/server";
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
import { AdminsOnly } from "@/components/settings/admins-only";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { buttonVariants } from "@/components/ui/button";
import {
  type FeedbackItem,
  getFeedbackForViewer,
  listFeedback,
} from "@/lib/api/feedback";
import { FEEDBACK_PAGE_SIZE } from "@/lib/api/feedback-schema";
import { auth } from "@/lib/auth";
import {
  backfillLinearSetup,
  getLinearConfigForAdmin,
  linearFeedbackViewUrl,
} from "@/lib/linear/config";
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
  // Setups saved before this version have no team key or project link, which
  // the "View in Linear" button needs. This fills them in after the response.
  after(backfillLinearSetup);

  // Full width because the table needs more room than the default column.
  return (
    <SettingsPageContent className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-pretty font-semibold text-lg tracking-tight">
            Feedback
          </h2>
          <p className="text-muted-foreground text-sm">
            Bugs and requests about Data Hub, sent from the app or an agent.
            Each one is an issue in Linear.
          </p>
        </div>
        <LinearReportsLink />
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
  status: "closed" | "open";
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
    itemId ? getFeedbackForViewer(itemId, viewer) : Promise.resolve(null),
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
          groups={list.groups}
          hrefFor={hrefFor}
          rows={list.items.map((item) => ({
            id: item.id,
            identifier: item.linearIssue.identifier,
            title: item.title,
            labels: item.linearIssue.labels,
            priority: item.linearIssue.priority,
            priorityLabel: item.linearIssue.priorityLabel,
            reporterName: reporterName(item),
            viaLabel: viaLabel(item),
            assignee: item.linearIssue.assignee
              ? {
                  userId: item.linearIssue.assignee.userId,
                  name: item.linearIssue.assignee.name,
                  avatarUrl: item.linearIssue.assignee.avatarUrl,
                }
              : null,
            stateId: item.linearIssue.stateId,
            stateColor: item.linearIssue.stateColor,
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
                activity: selected.activity ?? [],
                assignee: selected.linearIssue.assignee,
                identifier: selected.linearIssue.identifier,
                labels: selected.linearIssue.labels,
                priority: selected.linearIssue.priority,
                priorityLabel: selected.linearIssue.priorityLabel,
                projectName: selected.linearIssue.projectName,
                reporterFirstName: reporterFirstName(selected),
                reporterName: reporterName(selected),
                stateColor: selected.linearIssue.stateColor,
                stateName: selected.linearIssue.stateName,
                teamName: selected.linearIssue.teamName,
                viaLabel: viaLabel(selected),
                linearUrl: selected.linearIssue.url,
              }
            : null
        }
        navIds={list.items.map((item) => item.id)}
        statusLabel={status}
        total={list.total}
      />
    </>
  );
}

function reporterName(item: Pick<FeedbackItem, "reporter">): string {
  return item.reporter?.name ?? item.reporter?.email ?? "Deleted user";
}

// The first word of the reporter's name, or null when their account is gone.
function reporterFirstName(item: FeedbackItem): string | null {
  const name = item.reporter?.name ?? item.reporter?.email;
  return name?.trim().split(/\s+/)[0] || null;
}

function viaLabel(item: FeedbackItem): string | null {
  return item.source === "web" ? null : (item.oauthClientName ?? "an agent");
}

async function LinearReportsLink() {
  const config = await getLinearConfigForAdmin();
  const href = linearFeedbackViewUrl({
    projectUrl: config.projectUrl,
    teamKey: config.teamKey,
    workspaceUrlKey: config.workspaceUrlKey,
  });
  if (!href) {
    return null;
  }
  return (
    <a
      className={buttonVariants({ size: "sm", variant: "outline" })}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      View in Linear
      <ExternalLinkIcon data-icon="inline-end" />
    </a>
  );
}
