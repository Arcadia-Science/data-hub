import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import { Analytics } from "@vercel/analytics/next";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { appDescription, appName, siteUrl } from "@/lib/shared";

const inter = Inter({
  subsets: ["latin"],
});

// Unlike the product app in `web/` (which is intentionally `noindex`), this
// docs site is public marketing content: we omit any `robots` restrictions so
// the default is fully indexable, and ship a sitemap + robots.txt to help
// crawlers and AI agents discover every page.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    template: `%s | ${appName}`,
    default: `${appName} Documentation`,
  },
  description: appDescription,
  openGraph: {
    siteName: `${appName} Documentation`,
    type: "website",
    locale: "en_US",
    url: siteUrl,
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html className={inter.className} lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        {/* Search API lives under `/docs` because this app is served as a
            microfrontend mounted at `/docs`; the apex is a separate app. */}
        <RootProvider search={{ options: { api: "/docs/api/search" } }}>
          {children}
        </RootProvider>
        <Analytics />
      </body>
    </html>
  );
}
