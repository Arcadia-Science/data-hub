"use client";

import { ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { ColonyDataTable } from "@/components/runs/colony-data-table";
import { ReportDataShell } from "@/components/runs/report-data-shell";
import { RunVideoPlayer } from "@/components/runs/run-video-player";
import { Button } from "@/components/ui/button";
import { useResolvedFileUrl } from "@/hooks/use-resolved-file-url";
import {
  fileStem,
  isCsvFile,
  isImageFile,
  isPdfFile,
  isVideoFile,
  posterFileIdsByVideoFilename,
} from "@/lib/runs/run-file-types";

export interface ReportSectionFile {
  category: "processed" | "raw";
  contentType: string | null;
  deletedAt: Date | null;
  filename: string;
  id: number;
}

function ProcessedImagePreview({ file }: { file: ReportSectionFile }) {
  const downloadUrl = useResolvedFileUrl(file.id);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">{file.filename}</h3>
        {downloadUrl && (
          <Button
            asChild
            className="h-7 gap-1 text-xs"
            size="sm"
            variant="ghost"
          >
            <a href={downloadUrl} rel="noopener noreferrer" target="_blank">
              <ExternalLink className="size-3" />
              Full size
            </a>
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-md border bg-muted/30">
        {downloadUrl ? (
          // biome-ignore lint/performance/noImgElement: auth-gated download URLs are not next/image candidates
          <img
            alt={file.filename}
            className="h-auto w-full"
            height={600}
            src={downloadUrl}
            width={800}
          />
        ) : (
          <div className="flex h-64 items-center justify-center text-muted-foreground text-sm">
            Loading{"\u2026"}
          </div>
        )}
      </div>
    </div>
  );
}

function PdfPreview({ file }: { file: ReportSectionFile }) {
  const downloadUrl = useResolvedFileUrl(file.id);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">{file.filename}</h3>
        {downloadUrl && (
          <Button
            asChild
            className="h-7 gap-1 text-xs"
            size="sm"
            variant="ghost"
          >
            <a href={downloadUrl} rel="noopener noreferrer" target="_blank">
              <ExternalLink className="size-3" />
              Open in new tab
            </a>
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-md border">
        {downloadUrl ? (
          <iframe
            className="h-[80vh] w-full"
            src={downloadUrl}
            title={file.filename}
          />
        ) : (
          <div className="flex h-[80vh] items-center justify-center text-muted-foreground text-sm">
            Loading{"\u2026"}
          </div>
        )}
      </div>
    </div>
  );
}

export function RunReportSection({
  files,
  title = "Report Data",
}: {
  files: ReportSectionFile[];
  title?: string;
}) {
  const {
    pdfFiles,
    posterFileIds,
    processedCsvs,
    processedImages,
    processedVideos,
  } = useMemo(() => {
    const processedCsvs: ReportSectionFile[] = [];
    const processedVideos: ReportSectionFile[] = [];
    const processedImages: ReportSectionFile[] = [];
    const pdfFiles: ReportSectionFile[] = [];
    const videoStems = new Set<string>();

    for (const file of files) {
      if (file.deletedAt !== null) {
        continue;
      }
      if (file.category === "processed" && isVideoFile(file)) {
        processedVideos.push(file);
        videoStems.add(fileStem(file.filename));
      }
    }
    for (const file of files) {
      if (file.deletedAt !== null) {
        continue;
      }
      if (file.category === "processed" && isCsvFile(file)) {
        processedCsvs.push(file);
      } else if (
        file.category === "processed" &&
        isImageFile(file) &&
        !videoStems.has(fileStem(file.filename))
      ) {
        processedImages.push(file);
      }
      if (isPdfFile(file)) {
        pdfFiles.push(file);
      }
    }

    return {
      pdfFiles,
      posterFileIds: posterFileIdsByVideoFilename(files),
      processedCsvs,
      processedImages,
      processedVideos,
    };
  }, [files]);

  const totalCount =
    processedCsvs.length +
    processedImages.length +
    processedVideos.length +
    pdfFiles.length;

  return (
    <ReportDataShell contentClassName="gap-6" count={totalCount} title={title}>
      {processedVideos.map((file) => (
        <RunVideoPlayer
          fileId={file.id}
          filename={file.filename}
          key={file.id}
          posterFileId={posterFileIds[file.filename]}
        />
      ))}
      {processedImages.map((file) => (
        <ProcessedImagePreview file={file} key={file.id} />
      ))}
      {processedCsvs.map((file) => (
        <ColonyDataTable file={file} key={file.id} />
      ))}
      {pdfFiles.map((file) => (
        <PdfPreview file={file} key={file.id} />
      ))}
    </ReportDataShell>
  );
}
