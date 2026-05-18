"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import type { RunFile } from "@/lib/api/instrument-runs";
import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|tiff?)$/i;

function isImageFile(file: RunFile): boolean {
  return (
    file.contentType?.startsWith("image/") === true ||
    IMAGE_EXTENSIONS.test(file.filename)
  );
}

function sortByFilename(a: RunFile, b: RunFile): number {
  return a.filename.localeCompare(b.filename, undefined, { numeric: true });
}

export function HinaReportSection({ files }: { files: RunFile[] }) {
  const processedImages = useMemo(
    () =>
      files
        .filter(
          (f) =>
            f.category === "processed" && f.deletedAt === null && isImageFile(f)
        )
        .sort(sortByFilename),
    [files]
  );

  const [api, setApi] = useState<CarouselApi | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (!api) return;
    // Subscribe to Embla's own "select" and "reInit" events — no synchronous
    // state sync needed on mount since Embla defaults to snap 0 which matches
    // our initial state. `reInit` covers the case where the carousel recalcs
    // after images load and potentially lands on a different snap.
    const onSelect = () => setCurrentIndex(api.selectedScrollSnap());
    api.on("select", onSelect);
    api.on("reInit", onSelect);
    return () => {
      api.off("select", onSelect);
      api.off("reInit", onSelect);
    };
  }, [api]);

  if (processedImages.length === 0) {
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

  const currentFile =
    processedImages[Math.min(currentIndex, processedImages.length - 1)];
  const currentDownloadUrl = `/api/v1/files/${currentFile.id}/download`;

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">
        Report Data{" "}
        <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
          {processedImages.length} image(s)
        </span>
      </h2>
      <Card size="sm">
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col">
              <h3 className="truncate text-sm font-medium">
                {currentFile.filename}
              </h3>
              <span className="font-mono text-xs text-muted-foreground">
                {currentIndex + 1} / {processedImages.length}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs"
              asChild
            >
              <a
                href={currentDownloadUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="size-3" />
                Full size
              </a>
            </Button>
          </div>
          <Carousel setApi={setApi} opts={{ loop: false }} className="w-full">
            <CarouselContent>
              {processedImages.map((file, i) => {
                const url = `/api/v1/files/${file.id}/download`;
                return (
                  <CarouselItem key={file.id}>
                    <div className="overflow-hidden rounded-md border bg-muted/30">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt={file.filename}
                        loading={i === 0 ? "eager" : "lazy"}
                        className="mx-auto block max-h-[70vh] w-auto object-contain"
                      />
                    </div>
                  </CarouselItem>
                );
              })}
            </CarouselContent>
            {processedImages.length > 1 && (
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
