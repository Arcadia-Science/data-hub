import { ExternalLink } from "lucide-react";
import { ColonyDataTable } from "@/components/runs/colony-data-table";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { RunFile } from "@/lib/api/instrument-runs";

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
        <h3 className="font-medium text-sm">{file.filename}</h3>
        <Button asChild className="h-7 gap-1 text-xs" size="sm" variant="ghost">
          <a href={downloadUrl} rel="noopener noreferrer" target="_blank">
            <ExternalLink className="size-3" />
            Full size
          </a>
        </Button>
      </div>
      <div className="overflow-hidden rounded-md border bg-muted/30">
        {/* biome-ignore lint/performance/noImgElement: auth-gated download URLs are not next/image candidates */}
        <img
          alt={file.filename}
          className="h-auto w-full"
          height={600}
          src={downloadUrl}
          width={800}
        />
      </div>
    </div>
  );
}

function PdfPreview({ file }: { file: RunFile }) {
  const downloadUrl = `/api/v1/files/${file.id}/download`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">{file.filename}</h3>
        <Button asChild className="h-7 gap-1 text-xs" size="sm" variant="ghost">
          <a href={downloadUrl} rel="noopener noreferrer" target="_blank">
            <ExternalLink className="size-3" />
            Open in new tab
          </a>
        </Button>
      </div>
      <div className="overflow-hidden rounded-md border">
        <iframe
          className="h-[80vh] w-full"
          src={downloadUrl}
          title={file.filename}
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
        <RunSectionHeading title="Report Data" />
        <Card size="sm">
          <CardContent>
            <p className="text-muted-foreground text-sm">
              No report data has been generated for this run.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <RunSectionHeading countLabel={totalCount} title="Report Data" />
      <Card size="sm">
        <CardContent className="flex flex-col gap-6">
          {processedImages.map((file) => (
            <ProcessedImagePreview file={file} key={file.id} />
          ))}
          {processedCsvs.map((file) => (
            <ColonyDataTable file={file} key={file.id} />
          ))}
          {pdfFiles.map((file) => (
            <PdfPreview file={file} key={file.id} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
