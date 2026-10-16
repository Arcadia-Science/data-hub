import { createSerializer } from "nuqs/server";
import { changelogSearchParams } from "@/lib/search-params";

const serializeChangelog = createSerializer(changelogSearchParams);

/** Path that opens the changelog window with one entry expanded. */
export function changelogEntryPath(entryId: string): string {
  return serializeChangelog("/", { changelog: entryId });
}
