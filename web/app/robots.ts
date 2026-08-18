import type { MetadataRoute } from "next";

// Bots that check robots.txt before showing a link preview. LinkedIn skips a
// site if anything blocks it, so these get everything. Notion never asks.
const UNFURL_BOT_USER_AGENTS = [
  "Slackbot",
  "Slackbot-LinkExpanding",
  "Discordbot",
  "LinkedInBot",
];

// The app stays hidden; the docs, home page, and icons don't. Google reads our
// favicon off the home page. `/$` is the home page and nothing below it.
const GENERIC_CRAWLER_ALLOWS = [
  "/$",
  "/favicon.ico",
  "/icon",
  "/apple-icon",
  "/docs",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: UNFURL_BOT_USER_AGENTS, allow: "/" },
      { userAgent: "*", allow: GENERIC_CRAWLER_ALLOWS, disallow: "/" },
    ],
    sitemap: "https://datahub.arcadiascience.com/docs/sitemap.xml",
  };
}
