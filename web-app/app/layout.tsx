import { Geist, Geist_Mono } from "next/font/google";

import "@/app/globals.css";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import {
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
                  <SidebarProvider>
                    <AppSidebar
                      session={session}
                      instruments={instruments}
                      watchers={watchers}
                      signOutAction={async () => {
                        "use server";
                        await signOut({ redirectTo: "/login" });
                      }}
                    />
                    <SidebarInset>
                      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
                        <SidebarTrigger />
                      </header>
                      {children}
                    </SidebarInset>
                  </SidebarProvider>
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
