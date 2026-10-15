interface ArchiveHrefOptions {
  categories?: readonly string[];
  dismissed?: boolean;
  // Narrows the archive to these files. The route gives these priority over
  // the filter options below.
  fileIds?: readonly number[];
  search?: string;
  statuses?: readonly string[];
}

/**
 * URL of the run's zip download. With no options it covers every downloadable
 * file in the run. The route resolves `search`, `category`, `status`, and
 * `dismissed` to the matching files on the server, so the zip honors the files
 * table's filters across every page. Lists use commas, like the table's URL.
 */
export function buildArchiveHref(
  instrumentId: string,
  runId: string,
  options: ArchiveHrefOptions = {}
): string {
  const base = `/api/v1/instruments/${encodeURIComponent(instrumentId)}/runs/${encodeURIComponent(runId)}/download-archive`;
  const params = new URLSearchParams();

  if (options.fileIds === undefined) {
    const search = options.search?.trim();
    if (search) {
      params.set("search", search);
    }
    if (options.categories && options.categories.length > 0) {
      params.set("category", options.categories.join(","));
    }
    if (options.statuses && options.statuses.length > 0) {
      params.set("status", options.statuses.join(","));
    }
    if (options.dismissed) {
      params.set("dismissed", "true");
    }
  } else {
    params.set("file_ids", options.fileIds.join(","));
  }

  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
