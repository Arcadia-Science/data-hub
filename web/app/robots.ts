import type { MetadataRoute } from "next";

// Product HTML stays disallowed. `/docs` is the public docs microfrontend.
// `/$` and the icon files are the Google exception: one favicon per hostname,
// discovered from a crawlable homepage and fetched by Googlebot-Image.
// LinkedInBot is an unfurl bot — it treats `Disallow: /` as "skip this host".
const UNFURL_BOT_USER_AGENTS = [
  "Slackbot",
  "Slackbot-LinkExpanding",
  "Discordbot",
  "LinkedInBot",
];

// `$` is the robots.txt end-of-URL anchor, so `/$` is the homepage only.
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
