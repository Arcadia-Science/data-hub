"use client";

import { useResolvedFileUrl } from "@/hooks/use-resolved-file-url";

// One report image, scaled down to fit the viewport height.
export function ReportImage({
  fileId,
  filename,
}: {
  fileId: number;
  filename: string;
}) {
  const src = useResolvedFileUrl(fileId);

  return src ? (
    <div className="overflow-hidden rounded-md border bg-muted/30">
      {/* biome-ignore lint/performance/noImgElement: auth-gated download URLs are not next/image candidates */}
      <img
        alt={filename}
        className="mx-auto block max-h-[70vh] w-auto object-contain"
        height={600}
        src={src}
        width={800}
      />
    </div>
  ) : (
    <div className="flex h-64 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground text-sm">
      Loading{"…"}
    </div>
  );
}
