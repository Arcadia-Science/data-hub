const PYPI_WATCHER_URL = "https://pypi.org/pypi/data-hub-watcher/json";

interface PypiReleaseFile {
  upload_time_iso_8601?: string;
  yanked?: boolean;
}

interface PypiPackageJson {
  releases?: Record<string, PypiReleaseFile[] | undefined>;
}

export interface WatcherVersionsResult {
  ok: boolean;
  versions: string[];
}

/**
 * Fetches published `data-hub-watcher` versions from the PyPI JSON API.
 * Cached for five minutes so the settings page stays responsive after a
 * fresh publish without hammering PyPI on every admin visit. Returns
 * `{ ok: false, versions: [] }` on any failure so the form can fall back
 * to free-text inputs.
 */
export async function fetchWatcherVersions(): Promise<WatcherVersionsResult> {
  try {
    const res = await fetch(PYPI_WATCHER_URL, {
      next: { revalidate: 300 },
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return { ok: false, versions: [] };
    }

    const data = (await res.json()) as PypiPackageJson;
    const releases = data.releases;
    if (!releases || typeof releases !== "object") {
      return { ok: false, versions: [] };
    }

    const ranked: { version: string; uploadedAt: number }[] = [];
    for (const [version, files] of Object.entries(releases)) {
      if (!Array.isArray(files) || files.length === 0) {
        continue;
      }
      // Drop fully-yanked releases so admins can't pin the fleet to a
      // version PyPI will refuse to serve.
      if (files.every((file) => file.yanked === true)) {
        continue;
      }
      let maxUpload = 0;
      for (const file of files) {
        if (!file.upload_time_iso_8601) {
          continue;
        }
        const ts = Date.parse(file.upload_time_iso_8601);
        if (!Number.isNaN(ts) && ts > maxUpload) {
          maxUpload = ts;
        }
      }
      ranked.push({ version, uploadedAt: maxUpload });
    }

    // Newest-first by upload time matches PyPI's "Release history" order
    // without reimplementing PEP 440 comparison in JS.
    ranked.sort((a, b) => b.uploadedAt - a.uploadedAt);
    return { ok: true, versions: ranked.map((entry) => entry.version) };
  } catch {
    return { ok: false, versions: [] };
  }
}
