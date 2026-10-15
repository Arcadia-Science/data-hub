import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { FeedbackMenuItem } from "@/components/feedback/feedback-menu-item";
import { DataHubFeedbackProvider } from "@/components/feedback/feedback-provider";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { NotificationsProvider } from "@/components/notifications/notifications-provider";
import { ArchiveDownloadProvider } from "@/components/runs/archive-download-provider";
import { SearchTrigger } from "@/components/search/search-trigger";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ViewerTimeZoneProvider } from "@/components/viewer-time-zone-provider";
import { trackEvent } from "@/lib/analytics/track";
import { countUnread } from "@/lib/api/notifications";
import { getSidebarInstruments } from "@/lib/api/sidebar";
import { auth, authInstance } from "@/lib/auth";
import { listChangelogEntries } from "@/lib/changelog/entries";
import { groupChangelogByDate } from "@/lib/changelog/group";
import { feedback } from "@/lib/feedback";
import { SIDEBAR_COOKIE_NAME } from "@/lib/sidebar-persistence";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

// Target of the skip link. It wraps the page content, below the header, and
// `tabIndex={-1}` lets the jump move keyboard focus there.
const MAIN_CONTENT_ID = "main-content";

/**
 * Signed-in app chrome (sidebar, header, notifications). Auth surfaces
 * (`/login`, `/consent`) live in `(auth)` so they never nest here — even
 * when a session cookie is present mid-OAuth.
 *
 * Unsigned visitors still reach these routes for link-unfurl metadata;
 * pages render `SignInRequired` in place of the body when there's no session.
 */
export default async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();

  // Fetch the per-request sidebar data alongside the session so the layout
  // doesn't introduce an additional round-trip. Skipped entirely when the
  // user isn't signed in — the unauthenticated routes don't render the
  // sidebar.
  //
  // The unread-count query rides alongside the sidebar fetches so the
  // notification bell renders with an accurate badge on first paint —
  // the partial `idx_notifications_user_id_unread` index keeps the
  // count cheap regardless of total notification volume.
  //
  // The changelog window opens from the account menu on every page. Grouping
  // here avoids a second request, and the files are small enough to send
  // with the sidebar.
  //
  // A failed feedback check only hides the Feedback menu item. It reads
  // columns that a new feedback package version can add, and the app can
  // deploy before the migration that adds them has run.
  const [instruments, initialUnreadCount, timeZone, feedbackEnabled] = session
    ? await Promise.all([
        getSidebarInstruments(),
        countUnread(session.user.id),
        getViewerTimeZone(),
        feedback.isConfigured().catch((error) => {
          console.error("Feedback setup check failed", error);
          return false;
        }),
      ])
    : [[], 0, "UTC", false];
  const changelogSections = session
    ? groupChangelogByDate(listChangelogEntries(), timeZone)
    : [];

  // Hydrate the sidebar's open/collapsed state from the cookie that
  // `SidebarProvider` writes on toggle. Defaulting to `true` keeps the
  // first-visit experience expanded.
  const sidebarCookie = (await cookies()).get(SIDEBAR_COOKIE_NAME)?.value;
  const sidebarDefaultOpen = sidebarCookie !== "false";

  if (!session) {
    return children;
  }

  // `router.refresh()` re-renders this layout (the files table polls every
  // few seconds). Only a document navigation should count as a visit.
  if ((await headers()).get("sec-fetch-mode") === "navigate") {
    trackEvent("web_visit", {
      user_id: session.user.id,
      is_admin: session.user.isAdmin,
    });
  }

  return (
    <ViewerTimeZoneProvider timeZone={timeZone}>
      <NotificationsProvider initialUnreadCount={initialUnreadCount}>
        <ArchiveDownloadProvider>
          {/* Wraps the whole shell, not just the sidebar: the review page and the
            Linear setup read their settings from it too. */}
          <DataHubFeedbackProvider>
            <SidebarProvider defaultOpen={sidebarDefaultOpen}>
              {/* First tab stop, so keyboard users can skip the sidebar and
                  the header buttons on every page. */}
              <a
                className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-background focus-visible:px-3 focus-visible:py-2 focus-visible:font-medium focus-visible:text-sm focus-visible:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
                href={`#${MAIN_CONTENT_ID}`}
              >
                Skip to Main Content
              </a>
              <AppSidebar
                changelogSections={changelogSections}
                instruments={instruments}
                session={session}
                signOutAction={async () => {
                  "use server";
                  await authInstance.api.signOut({
                    headers: await headers(),
                  });
                  redirect("/login");
                }}
              >
                {feedbackEnabled ? <FeedbackMenuItem /> : null}
              </AppSidebar>
              {/* `min-w-0` lets the main pane shrink beside the sidebar so wide
                tables scroll inside their container instead of stretching the page. */}
              <SidebarInset className="min-w-0 pb-12">
                <header className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
                  <div className="flex h-8 items-center">
                    <SidebarTrigger />
                  </div>
                  <div className="flex h-8 items-center gap-2">
                    <SearchTrigger />
                    <NotificationBell />
                  </div>
                </header>
                <div
                  className="flex flex-1 flex-col focus:outline-none"
                  id={MAIN_CONTENT_ID}
                  tabIndex={-1}
                >
                  {children}
                </div>
              </SidebarInset>
            </SidebarProvider>
          </DataHubFeedbackProvider>
        </ArchiveDownloadProvider>
      </NotificationsProvider>
    </ViewerTimeZoneProvider>
  );
}
