import { ExternalLink } from "lucide-react";
import { ColonyDataTable } from "@/components/runs/colony-data-table";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { RunFile } from "@/lib/api/instrument-runs";
import {
  fileStem,
  isCsvFile,
  isImageFile,
  isPdfFile,
  isVideoFile,
} from "@/lib/runs/run-file-types";

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

function ProcessedVideoPreview({
  file,
  posterUrl,
}: {
  file: RunFile;
  posterUrl?: string;
}) {
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
      <div className="overflow-hidden rounded-md border bg-muted/30">
        {/* biome-ignore lint/a11y/useMediaCaption: instrument preview has no captions */}
        <video
          className="h-auto max-h-[70vh] w-full"
          controls
          playsInline
          poster={posterUrl}
          src={downloadUrl}
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

export function RunReportSection({
  files,
  title = "Report Data",
}: {
  files: RunFile[];
  title?: string;
}) {
  const processedCsvs = files.filter(
    (f) => f.category === "processed" && f.deletedAt === null && isCsvFile(f)
  );

  const processedVideos = files.filter(
    (f) => f.category === "processed" && f.deletedAt === null && isVideoFile(f)
  );
  const videoStems = new Set(processedVideos.map((f) => fileStem(f.filename)));

  const processedImages = files.filter(
    (f) =>
      f.category === "processed" &&
      f.deletedAt === null &&
      isImageFile(f) &&
      !videoStems.has(fileStem(f.filename))
  );

  const pdfFiles = files.filter((f) => f.deletedAt === null && isPdfFile(f));

  const totalCount =
    processedCsvs.length +
    processedImages.length +
    processedVideos.length +
    pdfFiles.length;

  if (totalCount === 0) {
    return (
      <div className="flex flex-col gap-2">
        <RunSectionHeading title={title} />
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
      <RunSectionHeading countLabel={totalCount} title={title} />
      <Card size="sm">
        <CardContent className="flex flex-col gap-6">
          {processedVideos.map((file) => {
            const poster = files.find(
              (candidate) =>
                candidate.category === "processed" &&
                candidate.deletedAt === null &&
                isImageFile(candidate) &&
                fileStem(candidate.filename) === fileStem(file.filename)
            );
            return (
              <ProcessedVideoPreview
                file={file}
                key={file.id}
                posterUrl={
                  poster ? `/api/v1/files/${poster.id}/download` : undefined
                }
              />
            );
          })}
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
