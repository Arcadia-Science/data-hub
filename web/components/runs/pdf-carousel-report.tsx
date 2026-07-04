"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import type { RunFile } from "@/lib/api/instrument-runs";

const PDF_EXTENSION = /\.pdf$/i;

function isPdfFile(file: RunFile): boolean {
  return (
    file.contentType === "application/pdf" || PDF_EXTENSION.test(file.filename)
  );
}

function sortByFilename(a: RunFile, b: RunFile): number {
  return a.filename.localeCompare(b.filename, undefined, { numeric: true });
}

// TapeStation and other PDF-primary instruments: carousel instead of the
// default `RunReportSection`, which stacks every PDF down the page.
export function PdfCarouselReport({ files }: { files: RunFile[] }) {
  const pdfs = useMemo(
    () =>
      files
        .filter((f) => f.deletedAt === null && isPdfFile(f))
        .sort(sortByFilename),
    [files]
  );

  const [api, setApi] = useState<CarouselApi | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (!api) {
      return;
    }
    const onSelect = () => setCurrentIndex(api.selectedScrollSnap());
    api.on("select", onSelect);
    api.on("reInit", onSelect);
    return () => {
      api.off("select", onSelect);
      api.off("reInit", onSelect);
    };
  }, [api]);

  if (pdfs.length === 0) {
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

  const currentFile = pdfs[Math.min(currentIndex, pdfs.length - 1)];
  const currentDownloadUrl = `/api/v1/files/${currentFile.id}/download`;

  return (
    <div className="flex flex-col gap-2">
      <RunSectionHeading countLabel={pdfs.length} title="Report Data" />
      <Card size="sm">
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col">
              <h3 className="truncate font-medium text-sm">
                {currentFile.filename}
              </h3>
              <span className="font-mono text-muted-foreground text-xs">
                {currentIndex + 1} / {pdfs.length}
              </span>
            </div>
            <Button
              asChild
              className="h-7 gap-1 text-xs"
              size="sm"
              variant="ghost"
            >
              <a
                href={currentDownloadUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink className="size-3" />
                Open in new tab
              </a>
            </Button>
          </div>
          <Carousel className="w-full" opts={{ loop: false }} setApi={setApi}>
            <CarouselContent>
              {pdfs.map((file, i) => {
                const url = `/api/v1/files/${file.id}/download`;
                return (
                  <CarouselItem key={file.id}>
                    <div className="overflow-hidden rounded-md border bg-muted/30">
                      {i === currentIndex ? (
                        <iframe
                          className="h-[70vh] w-full"
                          src={url}
                          title={file.filename}
                        />
                      ) : (
                        <div className="flex h-[70vh] items-center justify-center bg-muted/20">
                          <span className="px-4 text-center text-muted-foreground text-sm">
                            {file.filename}
                          </span>
                        </div>
                      )}
                    </div>
                  </CarouselItem>
                );
              })}
            </CarouselContent>
            {pdfs.length > 1 && (
              <>
                <CarouselPrevious className="left-2" />
                <CarouselNext className="right-2" />
              </>
            )}
          </Carousel>
        </CardContent>
      </Card>
    </div>
  );
}
