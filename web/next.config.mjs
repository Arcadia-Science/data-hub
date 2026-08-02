import { withMicrofrontends } from "@vercel/microfrontends/next/config";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Belt-and-braces against search indexing: the `robots` field in the root
  // layout's metadata already injects a `<meta name="robots">` tag into HTML
  // responses, but that tag is invisible on non-HTML responses (API JSON,
  // 3xx redirects from the proxy, error pages). The `X-Robots-Tag` header
  // covers those too. `app/robots.ts` is the third layer (robots.txt).
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
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default withMicrofrontends(nextConfig);
