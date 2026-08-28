import { authBaseURL } from "@/lib/auth";

// Local-mirror helpers return a path like `/api/local-s3/...`. Inside a
// cross-origin View iframe that resolves against the sandbox origin, so MCP
// app-visible tools must prefix the app origin.
export function toAbsoluteDownloadUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${authBaseURL}${path}`;
}
