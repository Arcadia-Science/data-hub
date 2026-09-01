import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { NotificationsProvider } from "@/components/notifications/notifications-provider";
import { ArchiveDownloadProvider } from "@/components/runs/archive-download-provider";
import { SearchTrigger } from "@/components/search/search-trigger";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { countUnread } from "@/lib/api/notifications";
import { getSidebarInstruments } from "@/lib/api/sidebar";
import { auth, authInstance } from "@/lib/auth";
import { SIDEBAR_COOKIE_NAME } from "@/lib/sidebar-persistence";

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
  const [instruments, initialUnreadCount] = session
    ? await Promise.all([getSidebarInstruments(), countUnread(session.user.id)])
    : [[], 0];

  // Hydrate the sidebar's open/collapsed state from the cookie that
  // `SidebarProvider` writes on toggle. Defaulting to `true` keeps the
  // first-visit experience expanded.
  const sidebarCookie = (await cookies()).get(SIDEBAR_COOKIE_NAME)?.value;
  const sidebarDefaultOpen = sidebarCookie !== "false";

  if (!session) {
    return children;
  }

  return (
    <NotificationsProvider initialUnreadCount={initialUnreadCount}>
      <ArchiveDownloadProvider>
        <SidebarProvider defaultOpen={sidebarDefaultOpen}>
          <AppSidebar
            instruments={instruments}
            session={session}
            signOutAction={async () => {
              "use server";
              await authInstance.api.signOut({
                headers: await headers(),
              });
              redirect("/login");
            }}
          />
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
            {children}
          </SidebarInset>
        </SidebarProvider>
      </ArchiveDownloadProvider>
    </NotificationsProvider>
  );
}
