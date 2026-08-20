import type { RunFile } from "@/lib/api/instrument-runs";

type RunFileIdentity = Pick<RunFile, "contentType" | "filename">;

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|tiff?)$/i;
const PDF_EXTENSION = /\.pdf$/i;
const CSV_EXTENSION = /\.csv$/i;
const VIDEO_EXTENSION = /\.mp4$/i;

export function fileStem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

export function isImageFile(file: RunFileIdentity): boolean {
  return (
    file.contentType?.startsWith("image/") === true ||
    IMAGE_EXTENSIONS.test(file.filename)
  );
}

export function isPdfFile(file: RunFileIdentity): boolean {
  return (
    file.contentType === "application/pdf" || PDF_EXTENSION.test(file.filename)
  );
}

export function isCsvFile(file: RunFileIdentity): boolean {
  return file.contentType === "text/csv" || CSV_EXTENSION.test(file.filename);
}

export function isVideoFile(file: RunFileIdentity): boolean {
  return (
    file.contentType?.startsWith("video/") === true ||
    VIDEO_EXTENSION.test(file.filename)
  );
}
