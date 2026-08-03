import { Geist, Geist_Mono } from "next/font/google";

import "@/app/globals.css";
import type { Metadata } from "next";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { PreviewDeploymentBanner } from "@/components/preview-deployment-banner";
import { ThemeProvider } from "@/components/theme-provider";
import { TimezoneCookieSync } from "@/components/timezone-cookie-sync";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

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
  // Deduped with page/stats callers via React.cache(); passed to the client
  // sync so we can skip refresh when the server zone already matches.
  const serverTimeZone = await getViewerTimeZone();

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
        <ThemeProvider>
          <TimezoneCookieSync serverTimeZone={serverTimeZone} />
          <NuqsAdapter>
            <TooltipProvider>
              <PreviewDeploymentBanner />
              {children}
              <Toaster />
            </TooltipProvider>
          </NuqsAdapter>
        </ThemeProvider>
      </body>
    </html>
  );
}
