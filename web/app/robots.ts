import type { MetadataRoute } from "next";

// Data Hub is an internal tool — every general-purpose crawler is blocked
// from the product itself. The one exception is `/docs`, which is served by
// the public docs microfrontend and is meant to be indexed; crawlers honor the
// more specific `allow: "/docs"` over the catch-all `disallow: "/"`.
//
// Slack consults robots.txt before generating link unfurls, so the bots
// that we *do* want to render previews (instrument + run titles for links
// pasted into Slack and Discord) are listed here explicitly with an
// `allow`. Notion's unfurler doesn't request robots.txt and therefore
// doesn't need to appear here.
const UNFURL_BOT_USER_AGENTS = [
  "Slackbot",
  "Slackbot-LinkExpanding",
  "Discordbot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: UNFURL_BOT_USER_AGENTS, allow: "/" },
      { userAgent: "*", allow: "/docs", disallow: "/" },
    ],
    sitemap: "https://datahub.arcadiascience.com/docs/sitemap.xml",
  };
}
