import { withMicrofrontends } from "@vercel/microfrontends/next/config";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The MCP server moved from `/api/v1/mcp` to `/mcp/v1`. MCP client configs
  // (Claude Desktop, Cursor, …) live on end users' machines and can't be
  // migrated for them, so the old paths keep working. 308 preserves the POST
  // method and body that the streamable-HTTP transport depends on.
  async redirects() {
    return [
      {
        source: "/api/v1/mcp",
        destination: "/mcp/v1",
        permanent: true,
      },
      {
        source: "/api/v1/mcp/schema.json",
        destination: "/mcp/v1/schema.json",
        permanent: true,
      },
    ];
  },

  async headers() {
    return [
      {
        // Says "don't index me" where a `<meta>` tag can't: JSON, redirects,
        // errors. The three icon files opt out — they become our favicon.
        source: "/((?!favicon\\.ico|icon\\.|apple-icon\\.).*)",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default withMicrofrontends(nextConfig);
