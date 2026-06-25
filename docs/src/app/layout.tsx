import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
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
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
