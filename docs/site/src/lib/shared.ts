export const appName = "Data Hub";
export const appDescription =
  "Data Hub automatically ingests, processes, and visualizes data from laboratory instruments. Learn how to install the watcher, manage API tokens, and onboard new instruments.";
export const docsRoute = "/docs";
export const docsImageRoute = "/docs/og/docs";
export const docsContentRoute = "/docs/llms.mdx/docs";

// Public production URL of the docs site. Used to build absolute URLs for
// metadata, Open Graph, the sitemap, and robots.txt. Set `NEXT_PUBLIC_SITE_URL`
// in the deployment; falls back to the per-deployment Vercel URL, then
// localhost for `next dev`.
export const siteUrl = (() => {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL;
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
})();

// Where a page's source lives on GitHub, for the "open in GitHub" link. The
// site goes live from the `production` branch, so that branch matches what
// readers see.
export const gitConfig = {
  user: "Arcadia-Science",
  repo: "data-hub",
  branch: "production",
  docsPath: "docs/site/content/docs",
};
