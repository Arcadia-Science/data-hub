import { authBaseURL } from "@/lib/auth";

// Local-mirror helpers return a bare path like `/api/local-s3/...`, which a
// cross-origin View iframe would resolve against the sandbox origin instead.
export function toAbsoluteDownloadUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${authBaseURL}${path}`;
}
