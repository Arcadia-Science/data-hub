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
    // A run's files sit in the raw bucket (instrument output) or the
    // processed bucket (Lambda artifacts) — `files.s3_bucket` decides per
    // row, so both origins have to be listed or half the report fails to
    // load. Archives are zips the View never renders, so they stay out.
    for (const bucket of [
      process.env.S3_RAW_DATA_BUCKET,
      process.env.S3_PROCESSED_BUCKET,
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
        // The View reads CSV and JSON bodies straight from S3 rather than
        // having the server parse them and return rows, so it needs the same
        // origins for `fetch`. The buckets allow this with a `*` CORS rule;
        // see `RawDataBucket` in `infra/template.yaml`.
        connectDomains: domains,
      },
      prefersBorder: true,
    },
  };
}
