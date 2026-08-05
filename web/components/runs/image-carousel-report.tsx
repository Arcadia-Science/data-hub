"use client";

import { useMemo, useState } from "react";
import { ReportItemSeeker } from "@/components/runs/report-item-seeker";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
import { Card, CardContent } from "@/components/ui/card";
import type { RunFile } from "@/lib/api/instrument-runs";
import { isBrowserRenderableImageFile } from "@/lib/runs/run-file-types";

function sortByFilename(a: RunFile, b: RunFile): number {
  return a.filename.localeCompare(b.filename, undefined, { numeric: true });
}

// For instruments whose report data is purely imagery (Hina microscope, gel
// doc): one image at a time with the shared filename seeker, instead of the
// default `RunReportSection`, which stacks every image down the page.
export function ImageCarouselReport({ files }: { files: RunFile[] }) {
  const images = useMemo(
    () =>
      files
        .filter((f) => f.deletedAt === null && isBrowserRenderableImageFile(f))
        .sort(sortByFilename),
    [files]
  );

  const seekItems = useMemo(
    () => images.map((file) => ({ id: file.id, filename: file.filename })),
    [images]
  );

  const [selectedId, setSelectedId] = useState<number | null>(
    () => images[0]?.id ?? null
  );

  if (images.length === 0) {
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

  const currentFile =
    images.find((file) => file.id === selectedId) ?? images[0];
  const currentDownloadUrl = `/api/v1/files/${currentFile.id}/download`;

  return (
    <div className="flex flex-col gap-2">
      <RunSectionHeading countLabel={images.length} title="Report Data" />
      <Card size="sm">
        <CardContent className="flex flex-col gap-3">
          <ReportItemSeeker
            emptyMessage="No images found."
            items={seekItems}
            nextAriaLabel="Next image"
            onSelect={setSelectedId}
            previousAriaLabel="Previous image"
            searchPlaceholder="Search images..."
            selectedId={currentFile.id}
            selectPlaceholder="Select an image…"
          />
          <div className="overflow-hidden rounded-md border bg-muted/30">
            {/* biome-ignore lint/performance/noImgElement: auth-gated download URLs are not next/image candidates */}
            <img
              alt={currentFile.filename}
              className="mx-auto block max-h-[70vh] w-auto object-contain"
              height={600}
              src={currentDownloadUrl}
              width={800}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
