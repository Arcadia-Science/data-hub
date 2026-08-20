import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

function fileDownloadUrl(fileId: number): string {
  return `/api/v1/files/${fileId}/download`;
}

export function RunVideoPlayer({
  fileId,
  filename,
  posterFileId,
}: {
  fileId: number;
  filename: string;
  posterFileId?: number;
}) {
  const downloadUrl = fileDownloadUrl(fileId);
  const posterUrl =
    posterFileId === undefined ? undefined : fileDownloadUrl(posterFileId);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate font-medium text-sm">{filename}</h3>
        <Button asChild className="h-7 gap-1 text-xs" size="sm" variant="ghost">
          <a href={downloadUrl} rel="noopener noreferrer" target="_blank">
            <ExternalLink className="size-3" />
            Open in new tab
          </a>
        </Button>
      </div>
      {/* `preload="none"` keeps the MP4 off the wire until play; the JPEG is the still. */}
      <div className="overflow-hidden rounded-md border bg-muted/30">
        {/* biome-ignore lint/a11y/useMediaCaption: instrument preview has no captions */}
        <video
          className="h-auto max-h-[70vh] w-full"
          controls
          key={fileId}
          playsInline
          poster={posterUrl}
          preload="none"
          src={downloadUrl}
        />
      </div>
    </div>
  );
}
