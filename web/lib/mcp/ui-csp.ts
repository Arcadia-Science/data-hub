import { authBaseURL } from "@/lib/auth";
import { s3BucketOrigin } from "@/lib/s3";
import { getLocalMirrorRoot } from "@/lib/s3-local-mirror";

function localDevOrigins(): string[] {
  if (process.env.NODE_ENV === "production") {
    return [];
  }
  return [authBaseURL, "http://localhost:3000", "http://127.0.0.1:3000"];
}

function runReportUiCspDomains(): string[] {
  const origins = new Set<string>();
  // The local mirror serves file bytes from the app's own origin, which
  // `localDevOrigins` already covers, so the S3 hosts are dead weight there.
  if (!getLocalMirrorRoot()) {
    for (const bucket of [
      process.env.S3_RAW_DATA_BUCKET,
      process.env.S3_ARCHIVES_BUCKET,
    ]) {
      if (bucket) {
        origins.add(s3BucketOrigin(bucket));
      }
    }
  }
  for (const origin of localDevOrigins()) {
    origins.add(origin);
  }
  return [...origins];
}

// Synchronous on purpose. `registerResource` needs this for `resources/list`
// before it can await anything, so an async source would advertise an empty
// policy on the first request to a cold instance and the real one afterwards.
export function runReportUiMeta() {
  const domains = runReportUiCspDomains();
  return {
    ui: {
      csp: {
        resourceDomains: domains,
        frameDomains: domains,
        // Tool calls travel through the host, so the View never issues a
        // cross-origin `fetch`. Declared and empty so that having a `csp`
        // object at all cannot grant one.
        connectDomains: [] as string[],
      },
      prefersBorder: true,
    },
  };
}
