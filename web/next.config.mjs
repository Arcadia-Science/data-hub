import { withMicrofrontends } from "@vercel/microfrontends/next/config";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Belt-and-braces against search indexing: the `robots` field in the root
  // layout's metadata already injects a `<meta name="robots">` tag into HTML
  // responses, but that tag is invisible on non-HTML responses (API JSON,
  // 3xx redirects from the proxy, error pages). The `X-Robots-Tag` header
  // covers those too. `app/robots.ts` is the third layer (robots.txt).
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
