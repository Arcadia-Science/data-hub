import { authBaseURL } from "@/lib/auth";
import { toAbsoluteDownloadUrl } from "@/lib/mcp/absolute-url";
import { getPresignedDownloadUrl } from "@/lib/s3";

let cachedDomains: string[] | undefined;
let inflight: Promise<string[]> | undefined;

function localDevOrigins(): string[] {
  if (process.env.NODE_ENV === "production") {
    return [];
  }
  return [authBaseURL, "http://localhost:3000", "http://127.0.0.1:3000"];
}

function cspFromDomains(domains: string[]) {
  return {
    ui: {
      csp: {
        resourceDomains: domains,
        frameDomains: domains,
        // The View loads images, video, and nested PDF frames from these
        // origins. Tool calls go through the host, so `connect-src` is
        // unused — keep it empty so a declared `csp` key does not grant
        // a cross-origin `fetch`.
        connectDomains: [] as string[],
      },
      prefersBorder: true,
    },
  };
}

async function probeBucketOrigin(bucket: string): Promise<string | undefined> {
  try {
    // Sign a throwaway key so the origin matches whatever style
    // `getPresignedDownloadUrl` actually emits (virtual-hosted, path-style,
    // custom endpoint, or the local-mirror path).
    const url = await getPresignedDownloadUrl(bucket, "__mcp-app-csp-probe__");
    return new URL(toAbsoluteDownloadUrl(url)).origin;
  } catch {
    return;
  }
}

export function runReportUiCspDomains(): Promise<string[]> {
  if (cachedDomains) {
    return Promise.resolve(cachedDomains);
  }
  if (!inflight) {
    inflight = (async () => {
      const origins = new Set<string>();
      for (const bucket of [
        process.env.S3_RAW_DATA_BUCKET,
        process.env.S3_ARCHIVES_BUCKET,
      ]) {
        if (!bucket) {
          continue;
        }
        const origin = await probeBucketOrigin(bucket);
        if (origin) {
          origins.add(origin);
        }
      }
      for (const origin of localDevOrigins()) {
        origins.add(origin);
      }
      const list = [...origins];
      cachedDomains = list;
      return list;
    })();
  }
  return inflight;
}

export function resetRunReportUiCspCache(): void {
  cachedDomains = undefined;
  inflight = undefined;
}

export function runReportUiMetaSnapshot() {
  return cspFromDomains(cachedDomains ?? localDevOrigins());
}

export async function runReportUiMeta() {
  const domains = await runReportUiCspDomains();
  return cspFromDomains(domains);
}
