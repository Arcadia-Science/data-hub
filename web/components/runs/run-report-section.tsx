import { ColonyDataTable } from "@/components/runs/colony-data-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { RunFile } from "@/lib/api/instrument-runs";
import { ExternalLink } from "lucide-react";

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|tiff?)$/i;
const PDF_EXTENSION = /\.pdf$/i;
const CSV_EXTENSION = /\.csv$/i;

function isImageFile(file: RunFile): boolean {
  return (
    file.contentType?.startsWith("image/") === true ||
    IMAGE_EXTENSIONS.test(file.filename)
  );
}

function isPdfFile(file: RunFile): boolean {
  return (
    file.contentType === "application/pdf" || PDF_EXTENSION.test(file.filename)
  );
}

function isCsvFile(file: RunFile): boolean {
  return file.contentType === "text/csv" || CSV_EXTENSION.test(file.filename);
}

function ProcessedImagePreview({ file }: { file: RunFile }) {
  const downloadUrl = `/api/v1/files/${file.id}/download`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{file.filename}</h3>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" asChild>
          <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-3" />
            Full size
          </a>
        </Button>
      </div>
      <div className="overflow-hidden rounded-md border bg-muted/30">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={downloadUrl} alt={file.filename} className="h-auto w-full" />
      </div>
    </div>
  );
}

function PdfPreview({ file }: { file: RunFile }) {
  const downloadUrl = `/api/v1/files/${file.id}/download`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{file.filename}</h3>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" asChild>
          <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-3" />
            Open in new tab
          </a>
        </Button>
      </div>
      <div className="overflow-hidden rounded-md border">
        <iframe
          src={downloadUrl}
          title={file.filename}
          className="h-[80vh] w-full"
        />
      </div>
    </div>
  );
}

export function RunReportSection({ files }: { files: RunFile[] }) {
  const processedCsvs = files.filter(
    (f) => f.category === "processed" && f.deletedAt === null && isCsvFile(f)
  );

  const processedImages = files.filter(
    (f) => f.category === "processed" && f.deletedAt === null && isImageFile(f)
  );

  const pdfFiles = files.filter((f) => f.deletedAt === null && isPdfFile(f));

  const totalCount =
    processedCsvs.length + processedImages.length + pdfFiles.length;

  if (totalCount === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Report Data</h2>
        <Card size="sm">
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No report data has been generated for this run.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">
        Report Data{" "}
        <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
          {totalCount} file(s)
        </span>
      </h2>
      <Card size="sm">
        <CardContent className="flex flex-col gap-6">
          {processedCsvs.map((file) => (
            <ColonyDataTable key={file.id} file={file} />
          ))}
          {processedImages.map((file) => (
            <ProcessedImagePreview key={file.id} file={file} />
          ))}
          {pdfFiles.map((file) => (
            <PdfPreview key={file.id} file={file} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
