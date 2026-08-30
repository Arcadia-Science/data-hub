import { authBaseURL } from "@/lib/auth";
import { s3BucketOrigin } from "@/lib/s3";
import { getLocalMirrorRoot } from "@/lib/s3-local-mirror";

function localDevOrigins(): string[] {
  if (process.env.NODE_ENV === "production") {
    return [];
  }
  return [authBaseURL, "http://localhost:3000", "http://127.0.0.1:3000"];
}

// A run's files split across these two, so leaving either one out breaks half
// the report. Archives are never rendered.
const BUCKET_ENV_VARS = ["S3_RAW_DATA_BUCKET", "S3_PROCESSED_BUCKET"] as const;

const warnedEnvVars = new Set<string>();

// An unset bucket produces a policy that blocks its files, and the only
// symptom is blank images in someone else's chat client. This cannot throw:
// `mcp-handler` rebuilds the server per request, so a throw here would take
// down every tool, not just the View. Warn instead, once per process rather
// than once per request.
function warnMissingBucket(envVar: string): void {
  if (warnedEnvVars.has(envVar)) {
    return;
  }
  warnedEnvVars.add(envVar);
  console.warn(
    `${envVar} is not set, so the MCP run report View is not allowed to load files from that bucket. See developer-docs/mcp-apps.md#content-security-policy.`
  );
}

export function resetRunReportUiCspWarnings(): void {
  warnedEnvVars.clear();
}

function runReportUiCspDomains(): string[] {
  const origins = new Set<string>();
  // The local mirror serves bytes from the app's own origin, already in
  // `localDevOrigins`, so the S3 hosts are dead weight there.
  if (!getLocalMirrorRoot()) {
    for (const envVar of BUCKET_ENV_VARS) {
      const bucket = process.env[envVar];
      if (bucket) {
        origins.add(s3BucketOrigin(bucket));
      } else {
        warnMissingBucket(envVar);
      }
    }
  }
  for (const origin of localDevOrigins()) {
    origins.add(origin);
  }
  return [...origins];
}

// Synchronous on purpose: `registerResource` needs this before it can await
// anything, so an async version would list an empty policy on a cold start.
export function runReportUiMeta() {
  const domains = runReportUiCspDomains();
  return {
    ui: {
      csp: {
        resourceDomains: domains,
        frameDomains: domains,
        // The View reads CSV and JSON straight from S3, so `fetch` needs the
        // same origins. See `RawDataBucket` CORS in `infra/template.yaml`.
        connectDomains: domains,
      },
      prefersBorder: true,
    },
  };
}
