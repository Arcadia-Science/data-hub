import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type FileStatus =
  | "detected"
  | "upload_requested"
  | "uploaded"
  | "processing"
  | "completed"
  | "failed";

const statusConfig: Record<
  FileStatus,
  {
    label: string;
    variant: "default" | "outline" | "secondary" | "destructive";
    className?: string;
  }
> = {
  detected: { label: "Detected", variant: "outline" },
  upload_requested: { label: "Upload Requested", variant: "secondary" },
  uploaded: { label: "Uploaded", variant: "secondary" },
  processing: { label: "Processing", variant: "default" },
  completed: {
    label: "Completed",
    variant: "default",
    className:
      "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  },
  failed: { label: "Failed", variant: "destructive" },
};

export function FileStatusBadge({ status }: { status: string }) {
  const config = statusConfig[status as FileStatus] ?? {
    label: status,
    variant: "outline" as const,
  };

  return (
    <Badge
      className={cn("text-[10px]", config.className)}
      variant={config.variant}
    >
      {config.label}
    </Badge>
  );
}
