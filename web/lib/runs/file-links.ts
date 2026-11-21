import type { RunFile } from "@/lib/api/instrument-runs";

// How the files of a run are linked to each other. The server uses these rules
// to find what a delete or a restore takes along (`findLinkedFiles`), and the
// file window uses them to list the linked files of the file it shows. Client
// safe, so both read the same definitions.

// How a linked file relates to the file it was found from.
// - `video`, `preview_image`, `output`: a processed file made from a raw file.
//   `output` is anything else, such as a colony table.
// - `sidecar`: the `run.json` saved with the raw file's capture.
// - `made_from`: the raw file a processed file was made from.
export type LinkedFileRelation =
  | "video"
  | "preview_image"
  | "output"
  | "sidecar"
  | "made_from";

// A DishCam sidecar is `run.json`, or `run~<8 or 16 hex digits>.json` when
// another folder already took the plain name. Matches `_RUN_JSON_RE` in
// `lambda/src/data_hub_lambda/dishcam/filenames.py`. The SQL pattern is the same
// rule for a Postgres `~*` match.
const SIDECAR_NAME = /^run(?:~[0-9a-f]{8}(?:[0-9a-f]{8})?)?\.json$/i;
export const SIDECAR_NAME_SQL = "^run(~[0-9a-f]{8}([0-9a-f]{8})?)?\\.json$";

const VIDEO_NAME = /\.(?:mp4|m4v|mov|webm)$/i;
const IMAGE_NAME = /\.(?:jpe?g|png|gif|webp)$/i;

export function isSidecarFilename(filename: string): boolean {
  return SIDECAR_NAME.test(filename);
}

// The folder of a stored path, or "" for a file in the watch folder. The same
// split as `folderOf` in `run-file-identity.ts`, kept in SQL as `folderSql`.
export function folderOfPath(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

// A file's stored path. A row from before paths were recorded has only a name.
export function pathOf(file: {
  filename: string;
  relativePath: string | null;
}): string {
  return file.relativePath ?? file.filename;
}

// What a processed file made from a raw file is: a video, a preview image, or
// another output.
export function outputRelation(file: {
  contentType: string | null;
  filename: string;
}): LinkedFileRelation {
  const type = file.contentType ?? "";
  if (type.startsWith("video/") || VIDEO_NAME.test(file.filename)) {
    return "video";
  }
  if (type.startsWith("image/") || IMAGE_NAME.test(file.filename)) {
    return "preview_image";
  }
  return "output";
}

type LinkableFile = Pick<
  RunFile,
  | "category"
  | "contentType"
  | "filename"
  | "id"
  | "relativePath"
  | "sourceFileId"
>;

// The order a file's linked files are listed in: what was made from it, then
// the sidecar of its capture.
const RELATION_ORDER: Record<LinkedFileRelation, number> = {
  video: 0,
  preview_image: 1,
  output: 2,
  sidecar: 3,
  made_from: 4,
};

export interface FileLink<T> {
  file: T;
  relation: LinkedFileRelation;
}

/**
 * The files in `candidates` that are linked to `file`, with how they relate to
 * it, whether or not they are deleted:
 * - for a raw file, the processed files made from it and the sidecars in its
 *   folder, and
 * - for a processed file, the raw file it was made from.
 * A sidecar has no links of its own. The window lists what it knows, so a
 * candidate that was not loaded is not listed.
 */
export function linkedFilesOf<T extends LinkableFile>(
  file: LinkableFile,
  candidates: readonly T[]
): FileLink<T>[] {
  if (file.category === "processed") {
    const source =
      file.sourceFileId === null
        ? undefined
        : candidates.find((candidate) => candidate.id === file.sourceFileId);
    return source ? [{ file: source, relation: "made_from" }] : [];
  }
  if (isSidecarFilename(file.filename)) {
    return [];
  }
  const folder = folderOfPath(pathOf(file));
  const links: FileLink<T>[] = [];
  for (const candidate of candidates) {
    if (candidate.id === file.id) {
      continue;
    }
    if (candidate.category === "processed") {
      if (candidate.sourceFileId === file.id) {
        links.push({ file: candidate, relation: outputRelation(candidate) });
      }
    } else if (
      isSidecarFilename(candidate.filename) &&
      folderOfPath(pathOf(candidate)) === folder
    ) {
      links.push({ file: candidate, relation: "sidecar" });
    }
  }
  return links.sort(
    (a, b) =>
      RELATION_ORDER[a.relation] - RELATION_ORDER[b.relation] ||
      a.file.id - b.file.id
  );
}

export interface LinkedFileLabel {
  // Text before the file name, for a row that reads "Made from <name>".
  lead: string | null;
  // Text after the file name.
  trail: string;
}

/**
 * The words that say how a linked file relates to the file in the window, and
 * that it is deleted when it is. A file made from the open file reads "Video
 * made from this file", and the raw file the open file was made from reads
 * "Made from <name>".
 */
export function linkedFileLabel(
  relation: LinkedFileRelation,
  deleted: boolean
): LinkedFileLabel {
  const suffix = deleted ? " · Deleted" : "";
  switch (relation) {
    case "video":
      return { lead: null, trail: `Video made from this file${suffix}` };
    case "preview_image":
      return {
        lead: null,
        trail: `Preview image made from this file${suffix}`,
      };
    case "output":
      return { lead: null, trail: `Made from this file${suffix}` };
    case "sidecar":
      return { lead: null, trail: `Saved with this capture${suffix}` };
    case "made_from":
      return { lead: "Made from", trail: suffix };
    default: {
      const unhandled: never = relation;
      return unhandled;
    }
  }
}
