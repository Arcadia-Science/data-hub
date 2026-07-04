import type { RunFile } from "@/lib/api/instrument-runs";

type RunFileIdentity = Pick<RunFile, "contentType" | "filename">;

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|tiff?)$/i;
const BROWSER_IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
const BROWSER_IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const PDF_EXTENSION = /\.pdf$/i;
const CSV_EXTENSION = /\.csv$/i;

export function isImageFile(file: RunFileIdentity): boolean {
  return (
    file.contentType?.startsWith("image/") === true ||
    IMAGE_EXTENSIONS.test(file.filename)
  );
}

// Carousel previews only — excludes `.tif`/`.nd2` and other non-browser formats.
export function isBrowserRenderableImageFile(file: RunFileIdentity): boolean {
  return (
    (file.contentType !== null &&
      BROWSER_IMAGE_CONTENT_TYPES.has(file.contentType)) ||
    BROWSER_IMAGE_EXTENSIONS.test(file.filename)
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
