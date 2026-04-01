import { Badge } from "@/components/ui/badge";
import { Upload } from "lucide-react";

type FileStatusSummaryProps = {
  fileCount: number;
  filesCompleted: number;
  filesFailed: number;
  filesPendingUpload: number;
};

export function FileStatusSummary({
  fileCount,
  filesCompleted,
  filesFailed,
  filesPendingUpload,
}: FileStatusSummaryProps) {
  if (fileCount === 0) {
    return <span className="text-xs text-muted-foreground">No files</span>;
  }

  const allDone = filesCompleted === fileCount;
  const hasFailed = filesFailed > 0;

  let variant: "default" | "destructive" | "secondary" = "secondary";
  if (allDone) variant = "default";
  if (hasFailed) variant = "destructive";

  return (
    <div className="flex items-center gap-1.5">
      <Badge variant={variant} className="font-mono text-[10px]">
        {filesCompleted}/{fileCount} processed
      </Badge>
      {filesPendingUpload > 0 && (
        <Badge variant="outline" className="gap-1 font-mono text-[10px]">
          <Upload className="size-3" />
          {filesPendingUpload}
        </Badge>
      )}
    </div>
  );
}
