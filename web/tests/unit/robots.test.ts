import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import nextConfig from "@/next.config.mjs";

interface CrawlRule {
  allow?: string | string[];
  disallow?: string | string[];
}

const toList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : [value].flat();

// How search engines read robots.txt: the longest matching line wins, and a
// trailing `$` means that exact URL.
function isAllowed(rule: CrawlRule | undefined, url: string): boolean {
  const directives = [
    ...toList(rule?.allow).map((path) => ({ path, allowed: true })),
    ...toList(rule?.disallow).map((path) => ({ path, allowed: false })),
  ];

  let winner: { length: number; allowed: boolean } | undefined;
  for (const { path, allowed } of directives) {
    const anchored = path.endsWith("$");
    const prefix = anchored ? path.slice(0, -1) : path;
    const matches = anchored ? url === prefix : url.startsWith(prefix);

    if (matches && (winner === undefined || prefix.length > winner.length)) {
      winner = { length: prefix.length, allowed };
    }
  }

  return winner?.allowed ?? true;
}

describe("robots()", () => {
  const manifest = robots();
  const rules = Array.isArray(manifest.rules)
    ? manifest.rules
    : [manifest.rules];

  const unfurl = rules.find((rule) =>
    toList(rule.userAgent).includes("LinkedInBot")
  );
  const generic = rules.find((rule) => rule.userAgent === "*");

  it("lets Slack, Discord, and LinkedInBot unfurl any product URL", () => {
    expect(unfurl?.userAgent).toEqual([
      "Slackbot",
      "Slackbot-LinkExpanding",
      "Discordbot",
      "LinkedInBot",
    ]);
    expect(isAllowed(unfurl, "/instruments/gel-doc-1/runs/abc")).toBe(true);
  });

  // Icon URLs carry a per-build `?...` suffix in production.
  it.each([
    "/",
    "/favicon.ico?favicon.1a1511uye4g_f.ico",
    "/icon.svg?icon.0x79zgd1fr42i.svg",
    "/apple-icon.png?apple-icon.13m44arz9-6-3.png",
    "/docs",
    "/docs/cli-reference",
  ])("lets generic crawlers fetch %s", (url) => {
    expect(isAllowed(generic, url)).toBe(true);
  });

  it.each([
    "/instruments",
    "/instruments/gel-doc-1/runs/abc",
    "/settings",
    "/login",
    "/api/v1/runs",
  ])("keeps generic crawlers out of %s", (url) => {
    expect(isAllowed(generic, url)).toBe(false);
  });

  it("points the sitemap at the public docs microfrontend", () => {
    expect(manifest.sitemap).toBe(
      "https://datahub.arcadiascience.com/docs/sitemap.xml"
    );
  });
});

const headerRoutes = (await nextConfig.headers?.()) ?? [];
const noindexRoute = headerRoutes.find((route) =>
  route.headers.some((header) => header.key === "X-Robots-Tag")
);

if (!noindexRoute) {
  throw new Error("next.config.mjs no longer sets an X-Robots-Tag header");
}

// Compile the pattern the way Next itself does, not with a lookalike regex.
const matchesNoindexRoute = getPathMatch(noindexRoute.source);

describe("X-Robots-Tag header", () => {
  it.each([
    "/",
    "/instruments/gel-doc-1",
    "/api/v1/runs",
    "/robots.txt",
  ])("keeps %s out of search indexes", (path) => {
    expect(matchesNoindexRoute(path)).not.toBe(false);
  });

  // These three become the favicon Google shows, so they must stay indexable.
  it.each([
    "/favicon.ico",
    "/icon.svg",
    "/apple-icon.png",
  ])("exempts the %s metadata route", (path) => {
    expect(matchesNoindexRoute(path)).toBe(false);
  });

  it("only exempts the icon files themselves", () => {
    expect(matchesNoindexRoute("/iconography")).not.toBe(false);
  });
});
