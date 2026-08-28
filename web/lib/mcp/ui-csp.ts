import { authBaseURL } from "@/lib/auth";

function s3VirtualHostedOrigin(bucket: string, region: string): string[] {
  const origins = [`https://${bucket}.s3.${region}.amazonaws.com`];
  // us-east-1 (and some older clients) also emit the regionless host.
  origins.push(`https://${bucket}.s3.amazonaws.com`);
  return origins;
}

// Origins the run-report View may load images, video, nested PDF frames, and
// optional direct `fetch` from. Anything omitted is denied by the host CSP.
export function runReportUiCspDomains(): string[] {
  const region = process.env.AWS_REGION ?? "us-west-1";
  const origins = new Set<string>();

  for (const bucket of [
    process.env.S3_RAW_DATA_BUCKET,
    process.env.S3_ARCHIVES_BUCKET,
  ]) {
    if (bucket) {
      for (const origin of s3VirtualHostedOrigin(bucket, region)) {
        origins.add(origin);
      }
    }
  }

  if (process.env.NODE_ENV !== "production") {
    origins.add(authBaseURL);
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
  }

  return [...origins];
}

export function runReportUiMeta() {
  const domains = runReportUiCspDomains();
  return {
    ui: {
      csp: {
        resourceDomains: domains,
        frameDomains: domains,
        connectDomains: domains,
      },
      prefersBorder: true,
    },
  };
}
