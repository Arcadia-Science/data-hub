const BASE_VERSION = "1.0.0";
const SHORT_SHA_LENGTH = 7;

// Sent to clients at initialize. The deployed commit goes in the version as
// semver build metadata, so a session's server version names the deploy it
// connected to. Local dev and tests have no commit and report the plain
// version. The catalog document (`lib/mcp/catalog/document.ts`) keeps the
// plain version so its snapshot doesn't change with every deploy.
export function mcpServerInfo(
  env: Record<string, string | undefined> = process.env
): { name: string; version: string } {
  const sha = env.VERCEL_GIT_COMMIT_SHA?.trim().slice(0, SHORT_SHA_LENGTH);
  return {
    name: "data-hub",
    version: sha ? `${BASE_VERSION}+${sha}` : BASE_VERSION,
  };
}
