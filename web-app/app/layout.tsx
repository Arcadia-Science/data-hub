import { Geist, Geist_Mono } from "next/font/google";

import "@/app/globals.css";
import { AppSidebar } from "@/components/app-sidebar";
import { ArchiveDownloadProvider } from "@/components/runs/archive-download-provider";
import { ThemeProvider } from "@/components/theme-provider";
import {
  SIDEBAR_COOKIE_NAME,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getSidebarInstruments, getSidebarWatchers } from "@/lib/api/sidebar";
import { auth, signOut } from "@/lib/auth";
import { cn } from "@/lib/utils";
import type { Metadata } from "next";
import { SessionProvider } from "next-auth/react";
import { cookies } from "next/headers";
import { NuqsAdapter } from "nuqs/adapters/next/app";

const fontSans = Geist({ subsets: ["latin"], variable: "--font-sans" });

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: {
    template: "%s | Data Hub",
    default: "Data Hub",
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
  const [instruments, watchers] = session
    ? await Promise.all([getSidebarInstruments(), getSidebarWatchers()])
    : [[], []];

  // Hydrate the sidebar's open/collapsed state from the cookie that
  // `SidebarProvider` writes on toggle. Defaulting to `true` keeps the
  // first-visit experience expanded.
  const sidebarCookie = (await cookies()).get(SIDEBAR_COOKIE_NAME)?.value;
  const sidebarDefaultOpen = sidebarCookie !== "false";

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        fontSans.variable
      )}
    >
      <body>
        <SessionProvider session={session}>
          <ThemeProvider>
            <NuqsAdapter>
              <TooltipProvider>
                {session ? (
                  <ArchiveDownloadProvider>
                    <SidebarProvider defaultOpen={sidebarDefaultOpen}>
                      <AppSidebar
                        session={session}
                        instruments={instruments}
                        watchers={watchers}
                        signOutAction={async () => {
                          "use server";
                          await signOut({ redirectTo: "/login" });
                        }}
                      />
                      <SidebarInset className="pb-12">
                        <header className="flex h-12 shrink-0 items-center gap-2 px-4">
                          <SidebarTrigger />
                        </header>
                        {children}
                      </SidebarInset>
                    </SidebarProvider>
                  </ArchiveDownloadProvider>
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
