import { Geist, Geist_Mono } from "next/font/google";

import "@/app/globals.css";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SessionProvider } from "next-auth/react";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AppSidebar } from "@/components/app-sidebar";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { NotificationsProvider } from "@/components/notifications/notifications-provider";
import { PreviewDeploymentBanner } from "@/components/preview-deployment-banner";
import { ArchiveDownloadProvider } from "@/components/runs/archive-download-provider";
import { SearchTrigger } from "@/components/search/search-trigger";
import { ThemeProvider } from "@/components/theme-provider";
import {
  SIDEBAR_COOKIE_NAME,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { countUnread } from "@/lib/api/notifications";
import {
  getActiveInstrumentIds,
  getSidebarInstruments,
} from "@/lib/api/sidebar";
import { auth, signOut } from "@/lib/auth";
import { cn } from "@/lib/utils";

const fontSans = Geist({ subsets: ["latin"], variable: "--font-sans" });

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

// `metadataBase` lets Next resolve relative URLs in `openGraph.images` etc.
// into absolute URLs that unfurlers can fetch. Prefer the current
// deployment's URL (set on every Vercel build) so preview deployments
// resolve to themselves; fall back to localhost for `next dev`.
const metadataBaseUrl = process.env.VERCEL_URL
  ? new URL(`https://${process.env.VERCEL_URL}`)
  : new URL("http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: metadataBaseUrl,
  title: {
    template: "%s | Data Hub",
    default: "Data Hub",
  },
  // OG defaults inherited by every page. We intentionally don't set
  // `openGraph.title` here because per-page `openGraph.title` strings
  // (set on instrument + run detail pages) should appear verbatim in
  // unfurl cards — adding a template at root would tack " | Data Hub"
  // onto every detail title and clutter the preview. `siteName` is
  // shown separately by Slack/Notion next to the favicon, which is
  // enough branding for the card header.
  openGraph: {
    siteName: "Data Hub",
    type: "website",
    locale: "en_US",
    images: [{ url: "/images/data-hub-logo.svg", alt: "Data Hub" }],
  },
  twitter: {
    card: "summary",
  },
  // Data Hub is an internal tool; we never want it indexed. The same
  // intent is reinforced by `app/robots.ts` (robots.txt) and an
  // `X-Robots-Tag` response header in `next.config.mjs`, so this stays
  // true even for non-HTML responses and for bots that only consult one
  // of the three signals.
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      "max-snippet": -1,
      "max-image-preview": "none",
      "max-video-preview": -1,
    },
  },
};

export default async function RootLayout({
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
  const [instruments, activeInstrumentIds, initialUnreadCount] = session
    ? await Promise.all([
        getSidebarInstruments(),
        getActiveInstrumentIds(),
        countUnread(session.user.id),
      ])
    : [[], [], 0];

  // Hydrate the sidebar's open/collapsed state from the cookie that
  // `SidebarProvider` writes on toggle. Defaulting to `true` keeps the
  // first-visit experience expanded.
  const sidebarCookie = (await cookies()).get(SIDEBAR_COOKIE_NAME)?.value;
  const sidebarDefaultOpen = sidebarCookie !== "false";

  // `--banner-height` is the single knob that offsets the body, the
  // viewport-fixed sidebar, and the full-height auth screen for the preview
  // banner. Left unset off preview, so each `var(..., 0px)` consumer is a no-op.
  const isPreview = process.env.VERCEL_ENV === "preview";

  return (
    <html
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        fontSans.variable
      )}
      data-preview-deployment={isPreview ? "" : undefined}
      lang="en"
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        <SessionProvider session={session}>
          <ThemeProvider>
            <NuqsAdapter>
              <TooltipProvider>
                <PreviewDeploymentBanner />
                {session ? (
                  <NotificationsProvider
                    initialUnreadCount={initialUnreadCount}
                  >
                    <ArchiveDownloadProvider>
                      <SidebarProvider defaultOpen={sidebarDefaultOpen}>
                        <AppSidebar
                          activeInstrumentIds={activeInstrumentIds}
                          instruments={instruments}
                          session={session}
                          signOutAction={async () => {
                            "use server";
                            await signOut({ redirectTo: "/login" });
                          }}
                        />
                        <SidebarInset className="pb-12">
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
                ) : (
                  children
                )}
                <Toaster />
              </TooltipProvider>
            </NuqsAdapter>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
