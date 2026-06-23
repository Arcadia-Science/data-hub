"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
    if (!api) {
      return;
    }
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
        <h2 className="font-semibold text-sm">Report Data</h2>
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
    processedImages[Math.min(currentIndex, processedImages.length - 1)];
  const currentDownloadUrl = `/api/v1/files/${currentFile.id}/download`;

  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-semibold text-sm">
        Report Data{" "}
        <span className="ml-1 font-mono font-normal text-muted-foreground text-xs">
          {processedImages.length} image(s)
        </span>
      </h2>
      <Card size="sm">
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col">
              <h3 className="truncate font-medium text-sm">
                {currentFile.filename}
              </h3>
              <span className="font-mono text-muted-foreground text-xs">
                {currentIndex + 1} / {processedImages.length}
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
                Full size
              </a>
            </Button>
          </div>
          <Carousel className="w-full" opts={{ loop: false }} setApi={setApi}>
            <CarouselContent>
              {processedImages.map((file, i) => {
                const url = `/api/v1/files/${file.id}/download`;
                return (
                  <CarouselItem key={file.id}>
                    <div className="overflow-hidden rounded-md border bg-muted/30">
                      {/* biome-ignore lint/performance/noImgElement: auth-gated download URLs are not next/image candidates */}
                      <img
                        alt={file.filename}
                        className="mx-auto block max-h-[70vh] w-auto object-contain"
                        height={600}
                        loading={i === 0 ? "eager" : "lazy"}
                        src={url}
                        width={800}
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
