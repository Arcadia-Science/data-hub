import { describe, expect, it } from "vitest";
import robots from "@/app/robots";

describe("robots()", () => {
  const manifest = robots();
  const rules = Array.isArray(manifest.rules)
    ? manifest.rules
    : [manifest.rules];

  const unfurl = rules.find((rule) =>
    Array.isArray(rule.userAgent)
      ? rule.userAgent.includes("LinkedInBot")
      : rule.userAgent === "LinkedInBot"
  );
  const generic = rules.find((rule) => rule.userAgent === "*");

  it("lets Slack, Discord, and LinkedInBot unfurl product URLs", () => {
    expect(unfurl?.userAgent).toEqual([
      "Slackbot",
      "Slackbot-LinkExpanding",
      "Discordbot",
      "LinkedInBot",
    ]);
    expect(unfurl?.allow).toBe("/");
  });

  it("lets generic crawlers fetch the homepage and icons without opening the app", () => {
    expect(generic?.allow).toEqual([
      "/$",
      "/favicon.ico",
      "/icon",
      "/apple-icon",
      "/docs",
    ]);
    expect(generic?.disallow).toBe("/");
  });

  it("points the sitemap at the public docs microfrontend", () => {
    expect(manifest.sitemap).toBe(
      "https://datahub.arcadiascience.com/docs/sitemap.xml"
    );
  });
});
