import type { MetadataRoute } from "next";

// Data Hub is an internal tool — every general-purpose crawler is blocked.
// Slack and Twitter consult robots.txt before generating link unfurls, so
// the bots that we *do* want to render previews (instrument + run titles
// for links pasted into Slack/Notion/etc.) are listed here explicitly with
// an `allow`. Notion's unfurler doesn't request robots.txt and therefore
// doesn't need to appear here.
const UNFURL_BOT_USER_AGENTS = [
  "Slackbot",
  "Slackbot-LinkExpanding",
  "Twitterbot",
  "facebookexternalhit",
  "LinkedInBot",
  "Discordbot",
  "TelegramBot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: UNFURL_BOT_USER_AGENTS, allow: "/" },
      { userAgent: "*", disallow: "/" },
    ],
  };
}
