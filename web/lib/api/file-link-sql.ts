import { sql } from "drizzle-orm";
import { files } from "@/lib/db/schema";
import { SIDECAR_NAME_SQL } from "@/lib/runs/file-links";

// The two SQL conditions that link files, kept beside `folderOfPath` and
// `isSidecarFilename` in `lib/runs/file-links.ts`, which say the same in
// TypeScript. Shared by the delete and restore code and by the run page's
// query for the files its window can reach.

// A row's folder, matching `folderOfPath`. A path with no slash has no folder,
// which `substring` reports as NULL.
export const folderSql = sql<string>`coalesce(substring(coalesce(${files.relativePath}, ${files.filename}) from '^(.*)/[^/]*$'), '')`;

// Whether a row's name is a sidecar's, matching `isSidecarFilename`.
export const isSidecarSql = sql`${files.filename} ~* ${SIDECAR_NAME_SQL}`;
