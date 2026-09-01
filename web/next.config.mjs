import path from "node:path";
import { fileURLToPath } from "node:url";
import { withMicrofrontends } from "@vercel/microfrontends/next/config";

const appDir = path.dirname(fileURLToPath(import.meta.url));

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

const withMfe = withMicrofrontends(nextConfig);

// Pin after `withMicrofrontends` so Turbopack writes into `web/.next`.
// An older disk cache stored assets under a `web/` prefix and restored
// them into `web/web/.next` on every `make dev`.
export default {
  ...withMfe,
  outputFileTracingRoot: appDir,
  turbopack: { ...withMfe.turbopack, root: appDir },
};
