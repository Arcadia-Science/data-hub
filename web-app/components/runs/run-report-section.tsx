import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RunFile } from "@/lib/api/instrument-runs";
import { ExternalLink } from "lucide-react";

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|tiff?)$/i;

function isImageFile(file: RunFile): boolean {
  return (
    file.contentType?.startsWith("image/") === true ||
    IMAGE_EXTENSIONS.test(file.filename)
  );
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

export function RunReportSection({ files }: { files: RunFile[] }) {
  const processedImages = files.filter(
    (f) => f.category === "processed" && f.deletedAt === null && isImageFile(f)
  );

  if (processedImages.length === 0) {
    return (
      <Card size="sm">
        <CardHeader>
          <CardTitle>Report Data</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No report data has been generated for this run.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          Report Data{" "}
          <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
            {processedImages.length} image(s)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {processedImages.map((file) => (
          <ProcessedImagePreview key={file.id} file={file} />
        ))}
      </CardContent>
    </Card>
  );
}
